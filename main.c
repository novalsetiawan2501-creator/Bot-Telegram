#include "http2loadtest.h"
#include <getopt.h>
#include <sys/resource.h>

_Atomic int  g_ready_workers = 0;
_Atomic int  g_total_ready_connections = 0;
_Atomic bool g_start_test = false;
_Atomic bool g_stop = false;

/* ======================================================================
 * URL parsing:  scheme://host[:port][/path]
 * ==================================================================== */
bool url_parse(const char *raw, url_t *out) {
    memset(out, 0, sizeof(*out));

    const char *p = raw;
    if (strncmp(p, "https://", 8) == 0) {
        out->tls = true;
        p += 8;
    } else if (strncmp(p, "http://", 7) == 0) {
        out->tls = false;
        p += 7;
    } else {
        return false;
    }
    if (*p == '\0') return false;

    const char *slash = strchr(p, '/');
    const char *hostport_end = slash ? slash : p + strlen(p);
    if (hostport_end == p) return false;

    const char *colon = memchr(p, ':', (size_t)(hostport_end - p));
    if (colon) {
        size_t hlen = (size_t)(colon - p);
        if (hlen == 0 || hlen >= sizeof(out->host)) return false;
        memcpy(out->host, p, hlen);
        out->host[hlen] = '\0';
        out->port = atoi(colon + 1);
        if (out->port <= 0 || out->port > 65535) return false;
    } else {
        size_t hlen = (size_t)(hostport_end - p);
        if (hlen == 0 || hlen >= sizeof(out->host)) return false;
        memcpy(out->host, p, hlen);
        out->host[hlen] = '\0';
        out->port = out->tls ? 443 : 80;
    }

    if (slash) {
        snprintf(out->path, sizeof(out->path), "%s", slash);
    } else {
        snprintf(out->path, sizeof(out->path), "/");
    }

    return true;
}

/* ======================================================================
 * latency histogram
 * ==================================================================== */
void hist_record(latency_hist_t *h, double latency_ms) {
    int idx = (int)latency_ms;
    if (idx < 0) idx = 0;
    if (idx > LATENCY_HIST_MS) idx = LATENCY_HIST_MS;
    h->buckets[idx]++;
}

static double hist_percentile(const latency_hist_t *merged, uint64_t total, double pct) {
    if (total == 0) return 0.0;
    uint64_t target = (uint64_t)(total * pct);
    uint64_t running = 0;
    for (int i = 0; i <= LATENCY_HIST_MS; i++) {
        running += merged->buckets[i];
        if (running > target) return (double)i;
    }
    return (double)LATENCY_HIST_MS;
}

/* ======================================================================
 * signal handling
 * ==================================================================== */
static void on_signal(int sig) {
    (void)sig;
    atomic_store_explicit(&g_stop, true, memory_order_relaxed);
}

/* ======================================================================
 * proxy file loader
 * ==================================================================== */
static bool load_proxies(config_t *config, const char *filename) {
    FILE *fp = fopen(filename, "r");
    if (!fp) {
        LOG_ERR("cannot open proxy file: %s", filename);
        return false;
    }

    char line[128];
    config->proxy_count = 0;
    config->proxies = NULL;

    while (fgets(line, sizeof(line), fp)) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = '\0';
        
        char *space = strchr(line, ':');
        if (!space) continue;
        
        *space = '\0';
        config->proxies = realloc(config->proxies, (config->proxy_count + 1) * sizeof(proxy_t));
        if (!config->proxies) {
            fclose(fp);
            return false;
        }
        
        strncpy(config->proxies[config->proxy_count].ip, line, 63);
        config->proxies[config->proxy_count].ip[63] = '\0';
        config->proxies[config->proxy_count].port = atoi(space + 1);
        config->proxy_count++;
    }

    fclose(fp);
    
    if (config->proxy_count == 0) {
        LOG_ERR("no valid proxies found in %s", filename);
        return false;
    }
    
    LOG_INFO("loaded %d proxies from %s", config->proxy_count, filename);
    return true;
}

/* ======================================================================
 * CLI
 * ==================================================================== */
static void print_usage(const char *prog) {
    printf(
        "High-performance HTTP/2 load testing tool (nghttp2 + epoll)\n"
        "usage: %s -u <url> [options]\n"
        "\n"
        "required:\n"
        "  -u, --url <url>            target URL, e.g. https://example.com/path\n"
        "\n"
        "options:\n"
        "  -d, --duration <sec>       test duration in seconds (default: %d)\n"
        "  -r, --rate <req/s>         target request rate; 0 = max throughput (default: 0)\n"
        "  -t, --threads <n>          worker threads (default: number of CPU cores)\n"
        "  -c, --connections <n>      total pooled connections across all threads (default: %d)\n"
        "  -m, --max-streams <n>      max concurrent HTTP/2 streams per connection (default: %d)\n"
        "      --warmup-timeout <s>   max seconds to wait for connections to warm up (default: %d)\n"
        "      --drain-timeout <s>    max seconds to wait for in-flight requests to finish (default: %d)\n"
        "  -p, --proxy <file>         proxy list file (format: ip:port per line)\n"
        "  -k, --insecure             skip TLS certificate verification\n"
        "  -v, --verbose              verbose logging\n"
        "  -h, --help                 show this help\n"
        "\n"
        "proxy format:\n"
        "  each line: IP:PORT\n"
        "  example:\n"
        "    192.168.1.1:8080\n"
        "    10.0.0.5:3128\n"
        "\n"
        "notes:\n"
        "  * rate 0 = max throughput (saturate connections)\n"
        "  * proxy mode: all connections go through HTTP CONNECT tunnel\n"
        "  * proxies are rotated globally using atomic round-robin\n"
        "  * Linux/epoll only.\n",
        prog, DEFAULT_DURATION_SEC, DEFAULT_CONNECTIONS, DEFAULT_MAX_CONCURRENT_STREAMS,
        DEFAULT_WARMUP_TIMEOUT_SEC, DEFAULT_DRAIN_TIMEOUT_SEC);
}

int main(int argc, char **argv) {
    config_t config;
    memset(&config, 0, sizeof(config));
    config.duration_sec = DEFAULT_DURATION_SEC;
    config.rate = 0.0;
    config.num_threads = 0;
    config.max_connections = DEFAULT_CONNECTIONS;
    config.max_concurrent_streams = DEFAULT_MAX_CONCURRENT_STREAMS;
    config.warmup_timeout_sec = DEFAULT_WARMUP_TIMEOUT_SEC;
    config.drain_timeout_sec = DEFAULT_DRAIN_TIMEOUT_SEC;
    config.insecure = false;
    config.verbose = false;
    config.use_proxy = false;
    config.proxies = NULL;
    config.proxy_count = 0;

    char *url_raw = NULL;
    char *proxy_file = NULL;

    static struct option long_opts[] = {
        {"url", required_argument, 0, 'u'},
        {"duration", required_argument, 0, 'd'},
        {"rate", required_argument, 0, 'r'},
        {"threads", required_argument, 0, 't'},
        {"connections", required_argument, 0, 'c'},
        {"max-streams", required_argument, 0, 'm'},
        {"warmup-timeout", required_argument, 0, 'W'},
        {"drain-timeout", required_argument, 0, 'D'},
        {"proxy", required_argument, 0, 'p'},
        {"insecure", no_argument, 0, 'k'},
        {"verbose", no_argument, 0, 'v'},
        {"help", no_argument, 0, 'h'},
        {0, 0, 0, 0}};

    int opt;
    while ((opt = getopt_long(argc, argv, "u:d:r:t:c:m:W:D:p:kvh", long_opts, NULL)) != -1) {
        switch (opt) {
        case 'u': url_raw = optarg; break;
        case 'd': config.duration_sec = atoi(optarg); break;
        case 'r': config.rate = atof(optarg); break;
        case 't': config.num_threads = atoi(optarg); break;
        case 'c': config.max_connections = atoi(optarg); break;
        case 'm': config.max_concurrent_streams = atoi(optarg); break;
        case 'W': config.warmup_timeout_sec = atoi(optarg); break;
        case 'D': config.drain_timeout_sec = atoi(optarg); break;
        case 'p': proxy_file = optarg; config.use_proxy = true; break;
        case 'k': config.insecure = true; break;
        case 'v': config.verbose = true; break;
        case 'h': print_usage(argv[0]); return 0;
        default: print_usage(argv[0]); return 1;
        }
    }

    if (!url_raw) {
        LOG_ERR("--url is required");
        print_usage(argv[0]);
        return 1;
    }
    if (!url_parse(url_raw, &config.url)) {
        LOG_ERR("could not parse URL: %s (expected scheme://host[:port][/path])", url_raw);
        return 1;
    }

    /* Load proxies if proxy mode is enabled */
    if (config.use_proxy) {
        if (!proxy_file) {
            LOG_ERR("-p/--proxy requires a file path");
            return 1;
        }
        if (!load_proxies(&config, proxy_file)) {
            return 1;
        }
    }

    struct rlimit rl;
    if (getrlimit(RLIMIT_NOFILE, &rl) == 0) {
        rl.rlim_cur = 65535;
        rl.rlim_max = 65535;
        setrlimit(RLIMIT_NOFILE, &rl);
        LOG_INFO("FD limit set to 65535");
    }
    if (config.num_threads <= 0) {
        long n = sysconf(_SC_NPROCESSORS_ONLN);
        config.num_threads = (n > 0) ? (int)n : 4;
    }
    if (config.max_connections <= 0) config.max_connections = DEFAULT_CONNECTIONS;
    if (config.max_connections < config.num_threads) {
        LOG_INFO("note: connections (%d) < threads (%d); using %d threads instead",
                 config.max_connections, config.num_threads, config.max_connections);
        config.num_threads = config.max_connections;
    }
    if (config.duration_sec <= 0) config.duration_sec = DEFAULT_DURATION_SEC;
    if (config.max_concurrent_streams <= 0) config.max_concurrent_streams = DEFAULT_MAX_CONCURRENT_STREAMS;
    if (config.warmup_timeout_sec <= 0) config.warmup_timeout_sec = DEFAULT_WARMUP_TIMEOUT_SEC;
    if (config.drain_timeout_sec <= 0) config.drain_timeout_sec = DEFAULT_DRAIN_TIMEOUT_SEC;

    /* Skip DNS resolution if using proxy - we connect to proxy IP directly */
    if (!config.use_proxy) {
        char port_str[16];
        snprintf(port_str, sizeof(port_str), "%d", config.url.port);
        struct addrinfo hints;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        struct addrinfo *res = NULL;
        int gai = getaddrinfo(config.url.host, port_str, &hints, &res);
        if (gai != 0 || !res) {
            LOG_ERR("DNS resolution failed for %s: %s", config.url.host, gai_strerror(gai));
            return 1;
        }
        memcpy(&config.addr, res->ai_addr, res->ai_addrlen);
        config.addr_len = (socklen_t)res->ai_addrlen;
        freeaddrinfo(res);
    } else {
        /* In proxy mode, we still need a dummy addr for the struct, but we won't use it */
        struct sockaddr_in dummy;
        dummy.sin_family = AF_INET;
        dummy.sin_port = htons(80);
        dummy.sin_addr.s_addr = inet_addr("0.0.0.0");
        memcpy(&config.addr, &dummy, sizeof(dummy));
        config.addr_len = sizeof(dummy);
    }

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    LOG_INFO("target:      %s://%s:%d%s", config.url.tls ? "https" : "http",
             config.url.host, config.url.port, config.url.path);
    LOG_INFO("duration:    %ds", config.duration_sec);
    if (config.rate > 0) {
        LOG_INFO("rate:        %.1f req/s", config.rate);
    } else {
        LOG_INFO("rate:        unlimited (max throughput)");
    }
    LOG_INFO("threads:     %d", config.num_threads);
    LOG_INFO("connections: %d", config.max_connections);
    LOG_INFO("max streams: %d per connection", config.max_concurrent_streams);
    if (config.use_proxy) {
        LOG_INFO("proxy:       enabled (%d proxies, global round-robin)", config.proxy_count);
    }
    LOG_INFO(" ");

    global_stats_t stats;
    memset(&stats, 0, sizeof(stats));

    worker_t *workers = calloc((size_t)config.num_threads, sizeof(worker_t));
    int base = config.max_connections / config.num_threads;
    int rem = config.max_connections % config.num_threads;
    for (int i = 0; i < config.num_threads; i++) {
        workers[i].index = i;
        workers[i].config = &config;
        workers[i].stats = &stats;
        workers[i].num_connections = base + (i < rem ? 1 : 0);
        /* NO proxy_offset - using global atomic counter */
    }

    LOG_INFO("warming up connections...");
    for (int i = 0; i < config.num_threads; i++) {
        pthread_create(&workers[i].thread_id, NULL, worker_run, &workers[i]);
    }

    while (atomic_load_explicit(&g_ready_workers, memory_order_relaxed) < config.num_threads &&
           !atomic_load_explicit(&g_stop, memory_order_relaxed)) {
        usleep(50000);
    }

    if (atomic_load_explicit(&g_stop, memory_order_relaxed)) {
        LOG_INFO("interrupted during warm-up, shutting down...");
        for (int i = 0; i < config.num_threads; i++) pthread_join(workers[i].thread_id, NULL);
        free(workers);
        if (config.proxies) free(config.proxies);
        return 1;
    }

    int ready_conns = atomic_load_explicit(&g_total_ready_connections, memory_order_relaxed);
    if (ready_conns == 0) {
        LOG_ERR("could not establish any connections to the target; aborting");
        atomic_store_explicit(&g_stop, true, memory_order_relaxed);
        for (int i = 0; i < config.num_threads; i++) pthread_join(workers[i].thread_id, NULL);
        free(workers);
        if (config.proxies) free(config.proxies);
        return 2;
    }
    if (ready_conns < config.max_connections) {
        LOG_INFO("warning: only %d/%d connections established", ready_conns, config.max_connections);
    }

    LOG_INFO("warm-up complete (%d connections) - starting %ds test", ready_conns, config.duration_sec);
    LOG_INFO(" ");
    atomic_store_explicit(&g_start_test, true, memory_order_relaxed);

    struct timespec t0;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    uint64_t last_total = 0;

    for (int elapsed = 1; elapsed <= config.duration_sec; elapsed++) {
        if (atomic_load_explicit(&g_stop, memory_order_relaxed)) break;
        sleep(1);

        uint64_t success = atomic_load_explicit(&stats.responses_2xx, memory_order_relaxed);
        uint64_t other = atomic_load_explicit(&stats.responses_other, memory_order_relaxed);
        uint64_t errs = atomic_load_explicit(&stats.stream_errors, memory_order_relaxed);
        uint64_t sum_us = atomic_load_explicit(&stats.latency_sum_us, memory_order_relaxed);
        uint64_t conns = atomic_load_explicit(&stats.active_connections, memory_order_relaxed);
        uint64_t total_completed = success + other + errs;
        uint64_t delta = total_completed - last_total;
        last_total = total_completed;

        double avg_ms = total_completed ? (sum_us / 1000.0) / total_completed : 0.0;

        LOG_INFO("[%3ds] rps=%-6llu total=%-8llu ok=%-8llu fail=%-6llu avg_latency=%.1fms conns=%llu",
                 elapsed, (unsigned long long)delta, (unsigned long long)total_completed,
                 (unsigned long long)success, (unsigned long long)(other + errs), avg_ms,
                 (unsigned long long)conns);

        if (atomic_load_explicit(&g_stop, memory_order_relaxed)) break;
    }

    atomic_store_explicit(&g_stop, true, memory_order_relaxed);
    LOG_INFO(" ");
    LOG_INFO("draining in-flight requests...");
    for (int i = 0; i < config.num_threads; i++) {
        pthread_join(workers[i].thread_id, NULL);
    }

    latency_hist_t merged;
    memset(&merged, 0, sizeof(merged));
    uint64_t hist_total = 0;
    for (int i = 0; i < config.num_threads; i++) {
        for (int b = 0; b <= LATENCY_HIST_MS; b++) {
            merged.buckets[b] += workers[i].hist.buckets[b];
            hist_total += workers[i].hist.buckets[b];
        }
    }

    uint64_t sent = atomic_load_explicit(&stats.requests_sent, memory_order_relaxed);
    uint64_t success = atomic_load_explicit(&stats.responses_2xx, memory_order_relaxed);
    uint64_t other = atomic_load_explicit(&stats.responses_other, memory_order_relaxed);
    uint64_t errs = atomic_load_explicit(&stats.stream_errors, memory_order_relaxed);
    uint64_t connerr = atomic_load_explicit(&stats.connect_errors, memory_order_relaxed);
    uint64_t bytes = atomic_load_explicit(&stats.bytes_received, memory_order_relaxed);
    uint64_t sum_us = atomic_load_explicit(&stats.latency_sum_us, memory_order_relaxed);
    uint64_t completed = success + other + errs;

    struct timespec t1;
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double wall_sec = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
    if (wall_sec <= 0) wall_sec = 1;

    LOG_INFO(" ");
    LOG_INFO("===== results =====");
    LOG_INFO("requests sent:      %llu", (unsigned long long)sent);
    LOG_INFO("responses received: %llu", (unsigned long long)completed);
    LOG_INFO("  2xx:               %llu", (unsigned long long)success);
    LOG_INFO("  non-2xx:           %llu", (unsigned long long)other);
    LOG_INFO("  stream errors:     %llu", (unsigned long long)errs);
    LOG_INFO("connection errors:  %llu", (unsigned long long)connerr);
    LOG_INFO("throughput:         %.1f req/s (%.2f MB/s)", completed / wall_sec,
             (bytes / (1024.0 * 1024.0)) / wall_sec);
    if (completed > 0) {
        LOG_INFO("latency avg:        %.2f ms", (sum_us / 1000.0) / completed);
        LOG_INFO("latency p50:        %.0f ms", hist_percentile(&merged, hist_total, 0.50));
        LOG_INFO("latency p90:        %.0f ms", hist_percentile(&merged, hist_total, 0.90));
        LOG_INFO("latency p99:        %.0f ms", hist_percentile(&merged, hist_total, 0.99));
    }

    if (config.proxies) free(config.proxies);
    free(workers);
    return 0;
}