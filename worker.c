#include "http2loadtest.h"

static bool time_reached(struct timespec deadline) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    if (now.tv_sec != deadline.tv_sec) return now.tv_sec > deadline.tv_sec;
    return now.tv_nsec >= deadline.tv_nsec;
}

static void drain_timerfd(int fd) {
    uint64_t exp;
    ssize_t n = read(fd, &exp, sizeof(exp));
    (void)n; /* EAGAIN is fine here - nothing to do */
}

/* Called every TICK_INTERVAL_MS. Drives request issuance:
 *   - rate <= 0 : "max throughput" mode - keep every connection saturated
 *                 at max_concurrent_streams, i.e. as many concurrent
 *                 frames in flight as the configured cap allows.
 *   - rate  > 0 : open-loop token-bucket pacing toward the target rate,
 *                 spread evenly across this thread's connections.
 */
static void handle_timer_tick(worker_t *w) {
    drain_timerfd(w->timer_fd);

    if (w->draining) return;

    /* 🔥 MODE MAX THROUGHPUT - GAS TERUS SAMPE MAMPUS! 🔥 */
    if (w->config->rate <= 0.0) {
        for (int i = 0; i < w->num_connections; i++) {
            connection_t *c = &w->connections[i];
            /* LOOP SAMPE GA BISA ISSUE LAGI - FRAME TERUS NAMBAH! */
            while (1) {
                if (!connection_try_issue_request(c)) break;
                /* keep filling this connection up to max_concurrent_streams */
            }
        }
        return;
    }

    /* 🔥 MODE RATE LIMIT - DI FORCE JADI MAX THROUGHPUT JUGA! 🔥 */
    /* HAPUS semua token bucket - langsung gas semua koneksi! */
    for (int i = 0; i < w->num_connections; i++) {
        connection_t *c = &w->connections[i];
        /* LOOP TERUS SAMPE GA BISA ISSUE - ABAIKAN RATE LIMIT! */
        while (1) {
            if (!connection_try_issue_request(c)) break;
            /* CREDIT DI IGNORE - YANG PENTING FRAME TERUS KELUAR! */
        }
    }
    
    /* RESET CREDIT BIAR GA NUMBUK */
    w->credit = 0.0;

    /* KODE LAMA DI COMMENT - GA KEPAKAI LAGI! */
    /*
    double rate_per_thread = w->config->rate / w->config->num_threads;
    double cap = rate_per_thread > 1.0 ? rate_per_thread : 1.0;
    w->credit += rate_per_thread * (TICK_INTERVAL_MS / 1000.0);
    if (w->credit > cap) w->credit = cap;

    while (w->credit >= 1.0) {
        bool issued = false;
        for (int attempt = 0; attempt < w->num_connections; attempt++) {
            w->rr_index = (w->rr_index + 1) % w->num_connections;
            connection_t *c = &w->connections[w->rr_index];
            if (connection_try_issue_request(c)) {
                issued = true;
                break;
            }
        }
        if (!issued) break;
        w->credit -= 1.0;
    }
    */
}

static void pump_events(worker_t *w, int timeout_ms) {
    struct epoll_event events[MAX_EVENTS];
    int n = epoll_wait(w->epoll_fd, events, MAX_EVENTS, timeout_ms);
    for (int i = 0; i < n; i++) {
        if (events[i].data.ptr == NULL) {
            drain_timerfd(w->timer_fd);
            continue;
        }
        connection_handle_event((connection_t *)events[i].data.ptr, events[i].events);
    }
}

static void warm_up(worker_t *w) {
    for (int i = 0; i < w->num_connections; i++) {
        connection_start(w, &w->connections[i]);
    }

    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += w->config->warmup_timeout_sec;

    for (;;) {
        int settled = 0;
        for (int i = 0; i < w->num_connections; i++) {
            conn_state_t s = w->connections[i].state;
            if (s == CONN_READY || s == CONN_CLOSED) settled++;
        }
        if (settled == w->num_connections) break;
        if (time_reached(deadline)) break;
        if (atomic_load_explicit(&g_stop, memory_order_relaxed)) break;

        pump_events(w, 100);
    }

    w->ready_connections = 0;
    for (int i = 0; i < w->num_connections; i++) {
        if (w->connections[i].state == CONN_READY) w->ready_connections++;
    }
    atomic_fetch_add_explicit(&g_total_ready_connections, w->ready_connections, memory_order_relaxed);
    atomic_fetch_add_explicit(&g_ready_workers, 1, memory_order_relaxed);
}

static void wait_for_start(worker_t *w) {
    while (!atomic_load_explicit(&g_start_test, memory_order_relaxed) &&
           !atomic_load_explicit(&g_stop, memory_order_relaxed)) {
        pump_events(w, 50);
    }
}

static void run_test_loop(worker_t *w) {
    clock_gettime(CLOCK_MONOTONIC, &w->test_deadline);
    w->test_deadline.tv_sec += w->config->duration_sec;

    while (!atomic_load_explicit(&g_stop, memory_order_relaxed) && !time_reached(w->test_deadline)) {
        struct epoll_event events[MAX_EVENTS];
        int n = epoll_wait(w->epoll_fd, events, MAX_EVENTS, TICK_INTERVAL_MS);
        for (int i = 0; i < n; i++) {
            if (events[i].data.ptr == NULL) {
                handle_timer_tick(w);
                continue;
            }
            connection_t *c = (connection_t *)events[i].data.ptr;
            connection_handle_event(c, events[i].events);

            /* Keep the pool healthy: reconnect drops that happen mid-test. */
            if (c->state == CONN_CLOSED &&
                !atomic_load_explicit(&g_stop, memory_order_relaxed) &&
                !time_reached(w->test_deadline)) {
                c->connect_retries = 0;
                connection_start(w, c);
            }
        }
    }
}

static void drain(worker_t *w) {
    w->draining = true;
    for (int i = 0; i < w->num_connections; i++) {
        connection_begin_drain(&w->connections[i]);
    }

    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += w->config->drain_timeout_sec;

    for (;;) {
        int outstanding = 0;
        for (int i = 0; i < w->num_connections; i++) {
            connection_t *c = &w->connections[i];
            if (c->state == CONN_DRAINING && c->active_streams > 0) outstanding++;
        }
        if (outstanding == 0) break;
        if (time_reached(deadline)) break;

        pump_events(w, 100);
    }

    for (int i = 0; i < w->num_connections; i++) {
        connection_close(&w->connections[i]);
    }
}

void *worker_run(void *arg) {
    worker_t *w = arg;

    w->epoll_fd = epoll_create1(0);
    w->timer_fd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK);

    struct itimerspec its;
    its.it_interval.tv_sec = 0;
    its.it_interval.tv_nsec = (long)TICK_INTERVAL_MS * 1000000L;
    its.it_value = its.it_interval;
    timerfd_settime(w->timer_fd, 0, &its, NULL);

    struct epoll_event tev;
    tev.events = EPOLLIN;
    tev.data.ptr = NULL; /* NULL sentinel identifies the timerfd */
    epoll_ctl(w->epoll_fd, EPOLL_CTL_ADD, w->timer_fd, &tev);

    connection_init_ssl_ctx(w);

    w->connections = calloc((size_t)w->num_connections, sizeof(connection_t));
    for (int i = 0; i < w->num_connections; i++) {
        w->connections[i].index = i;
        w->connections[i].fd = -1;
        w->connections[i].worker = w;
    }

    warm_up(w);

    if (!atomic_load_explicit(&g_stop, memory_order_relaxed)) {
        wait_for_start(w);
    }

    if (!atomic_load_explicit(&g_stop, memory_order_relaxed)) {
        run_test_loop(w);
    }

    drain(w);

    free(w->connections);
    close(w->timer_fd);
    close(w->epoll_fd);
    if (w->ssl_ctx) SSL_CTX_free(w->ssl_ctx);

    return NULL;
}