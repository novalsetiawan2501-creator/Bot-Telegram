#ifndef HTTP2LOADTEST_H
#define HTTP2LOADTEST_H

#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <pthread.h>
#include <time.h>
#include <errno.h>
#include <unistd.h>
#include <signal.h>

#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/timerfd.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <netdb.h>
#include <fcntl.h>

#include <openssl/ssl.h>
#include <openssl/err.h>

#include <nghttp2/nghttp2.h>

/* ---------------------------------------------------------------------- */
/* tunables                                                                */
/* ---------------------------------------------------------------------- */
#define MAX_EVENTS                      256
#define DEFAULT_MAX_CONCURRENT_STREAMS  100
#define DEFAULT_DURATION_SEC            30
#define DEFAULT_CONNECTIONS             10
#define DEFAULT_WARMUP_TIMEOUT_SEC      10
#define DEFAULT_DRAIN_TIMEOUT_SEC       5
#define TICK_INTERVAL_MS                10
#define MAX_CONNECT_RETRIES             3
#define LATENCY_HIST_MS                 10000 /* 1ms buckets 0..9999, +1 overflow bucket */

/* ---------------------------------------------------------------------- */
/* connection state machine                                               */
/* ---------------------------------------------------------------------- */
typedef enum {
    CONN_IDLE = 0,
    CONN_CONNECTING,
    CONN_TLS_HANDSHAKE,
    CONN_READY,
    CONN_DRAINING,
    CONN_CLOSED
} conn_state_t;

/* ---------------------------------------------------------------------- */
/* parsed target URL                                                      */
/* ---------------------------------------------------------------------- */
typedef struct {
    bool tls;
    char host[256];
    int  port;
    char path[2048];
} url_t;

/* ---------------------------------------------------------------------- */
/* global configuration (read-only once the test starts)                  */
/* ---------------------------------------------------------------------- */
typedef struct {
    url_t  url;
    int    duration_sec;
    double rate;                 /* target requests/sec; <= 0 means "max throughput" */
    int    num_threads;
    int    max_connections;
    int    max_concurrent_streams;
    int    warmup_timeout_sec;
    int    drain_timeout_sec;
    bool   insecure;             /* skip TLS certificate verification */
    bool   verbose;

    struct sockaddr_storage addr;
    socklen_t addr_len;
} config_t;

/* ---------------------------------------------------------------------- */
/* latency histogram - owned and written by a single worker thread only   */
/* ---------------------------------------------------------------------- */
typedef struct {
    uint64_t buckets[LATENCY_HIST_MS + 1];
} latency_hist_t;

/* ---------------------------------------------------------------------- */
/* process-wide stats shared across threads - atomics only                */
/* ---------------------------------------------------------------------- */
typedef struct {
    _Atomic uint64_t requests_sent;
    _Atomic uint64_t responses_2xx;
    _Atomic uint64_t responses_other;   /* non-2xx HTTP status received */
    _Atomic uint64_t stream_errors;     /* transport / protocol level failures */
    _Atomic uint64_t connect_errors;
    _Atomic uint64_t bytes_received;
    _Atomic uint64_t latency_sum_us;
    _Atomic uint64_t active_connections;
} global_stats_t;

/* ---------------------------------------------------------------------- */
/* per-request bookkeeping, passed around as the nghttp2 stream user data  */
/* ---------------------------------------------------------------------- */
typedef struct {
    struct timespec start_ts;
    int status_code;
} request_ctx_t;

struct worker;

/* ---------------------------------------------------------------------- */
/* one HTTP/2 connection (one TCP socket + one nghttp2 session)           */
/* ---------------------------------------------------------------------- */
typedef struct connection {
    struct worker *worker;
    int index;

    int fd;
    SSL *ssl;                    /* NULL for plaintext h2c connections */
    nghttp2_session *session;

    conn_state_t state;
    int active_streams;
    int connect_retries;
    bool want_write;             /* set when the TLS layer needs a write to progress */
    uint32_t registered_events;  /* epoll events currently registered, 0 = not registered */
} connection_t;

/* ---------------------------------------------------------------------- */
/* one worker OS thread; owns a slice of the connection pool              */
/* ---------------------------------------------------------------------- */
typedef struct worker {
    pthread_t thread_id;
    int index;

    const config_t *config;
    global_stats_t *stats;
    latency_hist_t hist;         /* private during the run, merged after join() */

    int epoll_fd;
    int timer_fd;

    connection_t *connections;
    int num_connections;
    int ready_connections;
    int rr_index;                /* round-robin cursor for request issuance */

    SSL_CTX *ssl_ctx;

    double credit;               /* fractional request credits for open-loop rate limiting */

    struct timespec test_deadline;
    bool draining;
} worker_t;

/* ---------------------------------------------------------------------- */
/* shared coordination flags (defined in main.c)                          */
/* ---------------------------------------------------------------------- */
extern _Atomic int  g_ready_workers;
extern _Atomic int  g_total_ready_connections;
extern _Atomic bool g_start_test;
extern _Atomic bool g_stop;

/* ---------------------------------------------------------------------- */
/* main.c                                                                  */
/* ---------------------------------------------------------------------- */
bool url_parse(const char *raw, url_t *out);
void hist_record(latency_hist_t *h, double latency_ms);

/* ---------------------------------------------------------------------- */
/* connection.c                                                           */
/* ---------------------------------------------------------------------- */
void connection_init_ssl_ctx(worker_t *w);
void connection_start(worker_t *w, connection_t *c);
void connection_handle_event(connection_t *c, uint32_t events);
bool connection_try_issue_request(connection_t *c);
void connection_begin_drain(connection_t *c);
void connection_close(connection_t *c);
void connection_update_epoll(connection_t *c);

/* ---------------------------------------------------------------------- */
/* worker.c                                                                */
/* ---------------------------------------------------------------------- */
void *worker_run(void *arg);

/* ---------------------------------------------------------------------- */
/* logging                                                                 */
/* ---------------------------------------------------------------------- */
#define LOG_ERR(fmt, ...)  do { fprintf(stderr, "[error] " fmt "\n", ##__VA_ARGS__); } while (0)
#define LOG_INFO(fmt, ...) do { fprintf(stdout, fmt "\n", ##__VA_ARGS__); } while (0)
#define LOG_VERBOSE(cfg, fmt, ...) \
    do { if ((cfg)->verbose) fprintf(stdout, "[verbose] " fmt "\n", ##__VA_ARGS__); } while (0)

#endif /* HTTP2LOADTEST_H */
