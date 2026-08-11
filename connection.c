#include "http2loadtest.h"

/* ======================================================================
 * nghttp2 <-> transport glue
 * ==================================================================== */

static ssize_t nghttp2_recv_cb(nghttp2_session *session, uint8_t *buf,
                                size_t length, int flags, void *user_data) {
    (void)session;
    (void)flags;
    connection_t *c = user_data;
    ssize_t n;

    if (c->ssl) {
        n = SSL_read(c->ssl, buf, (int)length);
        if (n <= 0) {
            int err = SSL_get_error(c->ssl, (int)n);
            if (err == SSL_ERROR_WANT_READ) {
                return NGHTTP2_ERR_WOULDBLOCK;
            }
            if (err == SSL_ERROR_WANT_WRITE) {
                c->want_write = true;
                return NGHTTP2_ERR_WOULDBLOCK;
            }
            if (err == SSL_ERROR_ZERO_RETURN) {
                return 0;
            }
            return NGHTTP2_ERR_CALLBACK_FAILURE;
        }
        return n;
    }

    n = read(c->fd, buf, length);
    if (n < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) return NGHTTP2_ERR_WOULDBLOCK;
        return NGHTTP2_ERR_CALLBACK_FAILURE;
    }
    return n;
}

static ssize_t nghttp2_send_cb(nghttp2_session *session, const uint8_t *data,
                                size_t length, int flags, void *user_data) {
    (void)session;
    (void)flags;
    connection_t *c = user_data;
    ssize_t n;

    if (c->ssl) {
        n = SSL_write(c->ssl, data, (int)length);
        if (n <= 0) {
            int err = SSL_get_error(c->ssl, (int)n);
            if (err == SSL_ERROR_WANT_WRITE || err == SSL_ERROR_WANT_READ) {
                return NGHTTP2_ERR_WOULDBLOCK;
            }
            return NGHTTP2_ERR_CALLBACK_FAILURE;
        }
        return n;
    }

    n = write(c->fd, data, length);
    if (n < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) return NGHTTP2_ERR_WOULDBLOCK;
        return NGHTTP2_ERR_CALLBACK_FAILURE;
    }
    return n;
}

static int on_header_cb(nghttp2_session *session, const nghttp2_frame *frame,
                         const uint8_t *name, size_t namelen,
                         const uint8_t *value, size_t valuelen,
                         uint8_t flags, void *user_data) {
    (void)flags;
    (void)user_data;

    if (frame->hd.type != NGHTTP2_HEADERS ||
        frame->headers.cat != NGHTTP2_HCAT_RESPONSE) {
        return 0;
    }
    if (namelen == 7 && memcmp(name, ":status", 7) == 0) {
        request_ctx_t *ctx = nghttp2_session_get_stream_user_data(session, frame->hd.stream_id);
        if (ctx) {
            char buf[16] = {0};
            size_t n = valuelen < sizeof(buf) - 1 ? valuelen : sizeof(buf) - 1;
            memcpy(buf, value, n);
            ctx->status_code = atoi(buf);
        }
    }
    return 0;
}

static int on_data_chunk_cb(nghttp2_session *session, uint8_t flags,
                             int32_t stream_id, const uint8_t *data,
                             size_t len, void *user_data) {
    (void)session;
    (void)flags;
    (void)stream_id;
    (void)data;
    connection_t *c = user_data;
    atomic_fetch_add_explicit(&c->worker->stats->bytes_received, len, memory_order_relaxed);
    return 0;
}

static int on_stream_close_cb(nghttp2_session *session, int32_t stream_id,
                               uint32_t error_code, void *user_data) {
    connection_t *c = user_data;
    global_stats_t *stats = c->worker->stats;

    request_ctx_t *ctx = nghttp2_session_get_stream_user_data(session, stream_id);
    if (ctx) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        double latency_ms = (now.tv_sec - ctx->start_ts.tv_sec) * 1000.0 +
                             (now.tv_nsec - ctx->start_ts.tv_nsec) / 1e6;
        uint64_t latency_us = (uint64_t)(latency_ms * 1000.0);

        if (error_code != NGHTTP2_NO_ERROR) {
            atomic_fetch_add_explicit(&stats->stream_errors, 1, memory_order_relaxed);
        } else if (ctx->status_code >= 200 && ctx->status_code < 300) {
            atomic_fetch_add_explicit(&stats->responses_2xx, 1, memory_order_relaxed);
        } else {
            atomic_fetch_add_explicit(&stats->responses_other, 1, memory_order_relaxed);
        }
        atomic_fetch_add_explicit(&stats->latency_sum_us, latency_us, memory_order_relaxed);
        hist_record(&c->worker->hist, latency_ms);

        free(ctx);
    }

    if (c->active_streams > 0) c->active_streams--;
    return 0;
}

/* ======================================================================
 * connection lifecycle
 * ==================================================================== */

void connection_init_ssl_ctx(worker_t *w) {
    if (!w->config->url.tls) {
        w->ssl_ctx = NULL;
        return;
    }

    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx) {
        LOG_ERR("failed to create SSL_CTX");
        exit(1);
    }
    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);

    SSL_CTX_set_cipher_list(ctx, 
        "ECDHE-ECDSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES128-GCM-SHA256:"
        "ECDHE-ECDSA-AES256-GCM-SHA384:"
        "ECDHE-RSA-AES256-GCM-SHA384:"
        "ECDHE-ECDSA-CHACHA20-POLY1305:"
        "ECDHE-RSA-CHACHA20-POLY1305:"
        "DHE-RSA-AES128-GCM-SHA256:"
        "DHE-RSA-AES256-GCM-SHA384"
    );

    SSL_CTX_set_ciphersuites(ctx, 
        "TLS_AES_128_GCM_SHA256:"
        "TLS_AES_256_GCM_SHA384:"
        "TLS_CHACHA20_POLY1305_SHA256"
    );

    if (w->config->insecure) {
        SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);
    } else {
        SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
        SSL_CTX_set_default_verify_paths(ctx);
    }

    static const unsigned char alpn[] = {2, 'h', '2'};
    SSL_CTX_set_alpn_protos(ctx, alpn, sizeof(alpn));

    w->ssl_ctx = ctx;
}

static void set_epoll(connection_t *c, uint32_t events) {
    struct epoll_event ev;
    ev.events = events;
    ev.data.ptr = c;

    if (c->registered_events == 0) {
        epoll_ctl(c->worker->epoll_fd, EPOLL_CTL_ADD, c->fd, &ev);
    } else if (c->registered_events != events) {
        epoll_ctl(c->worker->epoll_fd, EPOLL_CTL_MOD, c->fd, &ev);
    }
    c->registered_events = events;
}

void connection_update_epoll(connection_t *c) {
    if (c->fd < 0 || c->state == CONN_CLOSED) return;

    uint32_t events = EPOLLIN;
    bool want_write = c->want_write;

    if (c->state == CONN_CONNECTING) {
        events = EPOLLOUT;
    } else if (c->state == CONN_TLS_HANDSHAKE) {
        events = EPOLLIN | EPOLLOUT;
    } else if (c->session) {
        if (nghttp2_session_want_write(c->session)) want_write = true;
        if (!nghttp2_session_want_read(c->session)) events &= ~EPOLLIN;
    }

    if (want_write) events |= EPOLLOUT;
    c->want_write = false;

    set_epoll(c, events);
}

static bool init_h2_session(connection_t *c) {
    nghttp2_session_callbacks *cbs;
    if (nghttp2_session_callbacks_new(&cbs) != 0) return false;

    nghttp2_session_callbacks_set_recv_callback(cbs, nghttp2_recv_cb);
    nghttp2_session_callbacks_set_send_callback(cbs, nghttp2_send_cb);
    nghttp2_session_callbacks_set_on_header_callback(cbs, on_header_cb);
    nghttp2_session_callbacks_set_on_data_chunk_recv_callback(cbs, on_data_chunk_cb);
    nghttp2_session_callbacks_set_on_stream_close_callback(cbs, on_stream_close_cb);

    int rv = nghttp2_session_client_new(&c->session, cbs, c);
    nghttp2_session_callbacks_del(cbs);
    if (rv != 0) return false;

    nghttp2_settings_entry iv[] = {
        {NGHTTP2_SETTINGS_ENABLE_PUSH, 0},
        {NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, (uint32_t)c->worker->config->max_concurrent_streams},
    };
    nghttp2_submit_settings(c->session, NGHTTP2_FLAG_NONE, iv, 2);

    return true;
}

static void fail_connect(connection_t *c) {
    if (c->fd >= 0) {
        if (c->registered_events) epoll_ctl(c->worker->epoll_fd, EPOLL_CTL_DEL, c->fd, NULL);
        close(c->fd);
        c->fd = -1;
    }
    c->registered_events = 0;

    if (c->connect_retries < MAX_CONNECT_RETRIES) {
        c->connect_retries++;
        connection_start(c->worker, c);
        return;
    }

    atomic_fetch_add_explicit(&c->worker->stats->connect_errors, 1, memory_order_relaxed);
    c->state = CONN_CLOSED;
}

void connection_start(worker_t *w, connection_t *c) {
    c->worker = w;
    c->ssl = NULL;
    c->session = NULL;
    c->active_streams = 0;
    c->want_write = false;
    c->registered_events = 0;
    c->state = CONN_CONNECTING;

    int family = w->config->addr.ss_family;
    c->fd = socket(family, SOCK_STREAM | SOCK_NONBLOCK, 0);
    if (c->fd < 0) {
        LOG_VERBOSE(w->config, "socket() failed: %s", strerror(errno));
        fail_connect(c);
        return;
    }

    int one = 1;
    setsockopt(c->fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    int rv = connect(c->fd, (struct sockaddr *)&w->config->addr, w->config->addr_len);
    if (rv < 0 && errno != EINPROGRESS) {
        LOG_VERBOSE(w->config, "connect() failed: %s", strerror(errno));
        fail_connect(c);
        return;
    }

    connection_update_epoll(c);
}

static bool finish_tcp_connect(connection_t *c) {
    int err = 0;
    socklen_t len = sizeof(err);
    if (getsockopt(c->fd, SOL_SOCKET, SO_ERROR, &err, &len) < 0 || err != 0) {
        return false;
    }
    return true;
}

static void begin_tls_or_h2(connection_t *c) {
    if (c->worker->config->url.tls) {
        c->ssl = SSL_new(c->worker->ssl_ctx);
        SSL_set_fd(c->ssl, c->fd);
        SSL_set_tlsext_host_name(c->ssl, c->worker->config->url.host);
        if (!c->worker->config->insecure) {
            SSL_set1_host(c->ssl, c->worker->config->url.host);
        }
        SSL_set_connect_state(c->ssl);
        c->state = CONN_TLS_HANDSHAKE;
        connection_handle_event(c, 0);
        return;
    }

    if (!init_h2_session(c)) {
        fail_connect(c);
        return;
    }
    c->state = CONN_READY;
    nghttp2_session_send(c->session);
    connection_update_epoll(c);
    atomic_fetch_add_explicit(&c->worker->stats->active_connections, 1, memory_order_relaxed);
}

static void drive_tls_handshake(connection_t *c) {
    int rv = SSL_connect(c->ssl);
    if (rv == 1) {
        const unsigned char *proto = NULL;
        unsigned int protolen = 0;
        SSL_get0_alpn_selected(c->ssl, &proto, &protolen);
        if (protolen != 2 || memcmp(proto, "h2", 2) != 0) {
            LOG_VERBOSE(c->worker->config, "server did not negotiate h2 via ALPN");
            SSL_free(c->ssl);
            c->ssl = NULL;
            fail_connect(c);
            return;
        }
        if (!init_h2_session(c)) {
            fail_connect(c);
            return;
        }
        c->state = CONN_READY;
        nghttp2_session_send(c->session);
        connection_update_epoll(c);
        atomic_fetch_add_explicit(&c->worker->stats->active_connections, 1, memory_order_relaxed);
        return;
    }

    int err = SSL_get_error(c->ssl, rv);
    if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
        connection_update_epoll(c);
        return;
    }

    LOG_VERBOSE(c->worker->config, "TLS handshake failed");
    SSL_free(c->ssl);
    c->ssl = NULL;
    fail_connect(c);
}

void connection_handle_event(connection_t *c, uint32_t events) {
    if (events & (EPOLLERR | EPOLLHUP)) {
        if (c->state == CONN_CONNECTING || c->state == CONN_TLS_HANDSHAKE) {
            fail_connect(c);
        } else {
            connection_close(c);
        }
        return;
    }

    switch (c->state) {
    case CONN_CONNECTING:
        if (!finish_tcp_connect(c)) {
            fail_connect(c);
            return;
        }
        begin_tls_or_h2(c);
        return;

    case CONN_TLS_HANDSHAKE:
        drive_tls_handshake(c);
        return;

    case CONN_READY:
    case CONN_DRAINING: {
        if (events & EPOLLIN) {
            int rv = nghttp2_session_recv(c->session);
            if (rv != 0) {
                connection_close(c);
                return;
            }
        }
        if ((events & EPOLLOUT) || nghttp2_session_want_write(c->session)) {
            int rv = nghttp2_session_send(c->session);
            if (rv != 0) {
                connection_close(c);
                return;
            }
        }
        if (!nghttp2_session_want_read(c->session) && !nghttp2_session_want_write(c->session)) {
            connection_close(c);
            return;
        }
        connection_update_epoll(c);
        return;
    }

    case CONN_IDLE:
    case CONN_CLOSED:
    default:
        return;
    }
}

bool connection_try_issue_request(connection_t *c) {
    if (c->state != CONN_READY) return false;

    const url_t *u = &c->worker->config->url;
    char authority[300];
    if ((u->tls && u->port != 443) || (!u->tls && u->port != 80)) {
        snprintf(authority, sizeof(authority), "%s:%d", u->host, u->port);
    } else {
        snprintf(authority, sizeof(authority), "%s", u->host);
    }

#define MAKE_NV(N, V) \
    { (uint8_t *)(N), (uint8_t *)(V), strlen(N), strlen(V), NGHTTP2_NV_FLAG_NONE }

    /* 🔥 HEADERS LENGKAP KAYAK BINARY (17 HEADERS!) 🔥 */
    nghttp2_nv nva[] = {
        MAKE_NV(":method", "GET"),
        MAKE_NV(":scheme", u->tls ? "https" : "http"),
        MAKE_NV(":authority", authority),
        MAKE_NV(":path", u->path),
        MAKE_NV("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"),
        MAKE_NV("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"),
        MAKE_NV("accept-encoding", "gzip, deflate, br, zstd"),
        MAKE_NV("accept-language", "en-US,en;q=0.9"),
        MAKE_NV("cache-control", "max-age=0"),
        MAKE_NV("sec-ch-ua", "\"Not(A:Brand\";v=\"99\", \"Google Chrome\";v=\"133\", \"Chromium\";v=\"133\""),
        MAKE_NV("sec-ch-ua-mobile", "?0"),
        MAKE_NV("sec-ch-ua-platform", "\"Windows\""),
        MAKE_NV("upgrade-insecure-requests", "1"),
        MAKE_NV("sec-fetch-site", "none"),
        MAKE_NV("sec-fetch-mode", "navigate"),
        MAKE_NV("sec-fetch-user", "?1"),
        MAKE_NV("sec-fetch-dest", "document"),
        MAKE_NV("priority", "u=0, i"),
    };
#undef MAKE_NV

    request_ctx_t *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) return false;
    clock_gettime(CLOCK_MONOTONIC, &ctx->start_ts);
    ctx->status_code = 0;

    int32_t sid = nghttp2_submit_request(c->session, NULL, nva,
                                          sizeof(nva) / sizeof(nva[0]), NULL, ctx);
    if (sid < 0) {
        free(ctx);
        return false;
    }

    c->active_streams++;
    atomic_fetch_add_explicit(&c->worker->stats->requests_sent, 1, memory_order_relaxed);

    nghttp2_session_send(c->session);
    connection_update_epoll(c);
    return true;
}

void connection_begin_drain(connection_t *c) {
    if (c->state != CONN_READY) return;
    c->state = CONN_DRAINING;
}

void connection_close(connection_t *c) {
    if (c->state == CONN_CLOSED) return;

    bool was_ready = (c->state == CONN_READY || c->state == CONN_DRAINING);

    if (c->session) {
        nghttp2_session_terminate_session(c->session, NGHTTP2_NO_ERROR);
        nghttp2_session_send(c->session);
        nghttp2_session_del(c->session);
        c->session = NULL;
    }
    if (c->ssl) {
        SSL_shutdown(c->ssl);
        SSL_free(c->ssl);
        c->ssl = NULL;
    }
    if (c->fd >= 0) {
        if (c->registered_events) epoll_ctl(c->worker->epoll_fd, EPOLL_CTL_DEL, c->fd, NULL);
        close(c->fd);
        c->fd = -1;
    }
    c->registered_events = 0;
    c->state = CONN_CLOSED;

    if (was_ready) {
        atomic_fetch_sub_explicit(&c->worker->stats->active_connections, 1, memory_order_relaxed);
    }
}