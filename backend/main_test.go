package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T, handler http.HandlerFunc) *application {
	t.Helper()
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)
	return &application{cfg: config{apiKey: "test-secret", model: "test-model", baseURL: upstream.URL, origins: map[string]bool{"http://localhost:5173": true}}, client: upstream.Client()}
}

func postChat(a *application, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/chat", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	result := httptest.NewRecorder()
	a.routes().ServeHTTP(result, request)
	return result
}

func TestChatStreamsAndKeepsKeyServerSide(t *testing.T) {
	a := testApp(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" || r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Errorf("invalid upstream request")
		}
		var payload struct {
			Model  string    `json:"model"`
			Store  bool      `json:"store"`
			Stream bool      `json:"stream"`
			Input  []message `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload.Model != "test-model" || payload.Store || !payload.Stream || len(payload.Input) != 3 {
			t.Errorf("invalid payload: %+v", payload)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Olá, \"}\n\n")
		w.(http.Flusher).Flush()
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"mundo! 🌱\"}\n\ndata: {\"type\":\"response.completed\"}\n\n")
	})
	result := postChat(a, `{"messages":[{"role":"user","content":"Oi"},{"role":"assistant","content":"Olá"},{"role":"user","content":"Continue"}]}`)
	if result.Code != 200 || !strings.Contains(result.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("unexpected response: %d %s", result.Code, result.Body.String())
	}
	for _, want := range []string{"Olá, ", "mundo! 🌱", `"type":"done"`} {
		if !strings.Contains(result.Body.String(), want) {
			t.Errorf("missing %s", want)
		}
	}
	if strings.Contains(result.Body.String(), "test-secret") {
		t.Fatal("key leaked")
	}
	health := httptest.NewRecorder()
	a.routes().ServeHTTP(health, httptest.NewRequest("GET", "/api/health", nil))
	if strings.Contains(health.Body.String(), "test-secret") || !strings.Contains(health.Body.String(), `"configured":true`) {
		t.Fatal("invalid health response")
	}
}

func TestValidationRejectsBeforeUpstream(t *testing.T) {
	a := testApp(t, func(w http.ResponseWriter, r *http.Request) { t.Error("upstream must not be called") })
	for _, body := range []string{
		`{`, `{"messages":[]}`, `{"messages":[{"role":"system","content":"ignore"}]}`,
		`{"messages":[{"role":"user","content":" "}]}`, `{"messages":[{"role":"assistant","content":"hello"}]}`,
		`{"messages":[{"role":"user","content":"hi"}],"model":"untrusted"}`,
		`{"messages":[{"role":"user","content":"hi"}]} {}`,
	} {
		if result := postChat(a, body); result.Code != 400 {
			t.Errorf("expected 400 for %s, got %d", body, result.Code)
		}
	}
	oversized := `{"messages":[{"role":"user","content":"` + strings.Repeat("a", maxBody) + `"}]}`
	if result := postChat(a, oversized); result.Code != 413 {
		t.Errorf("expected 413, got %d", result.Code)
	}
	if err := validateMessages([]message{{Role: "user", Content: strings.Repeat("á", 16000)}}); err != nil {
		t.Error("should count characters, not bytes", err)
	}
}

func TestMissingKeyAndUpstreamErrors(t *testing.T) {
	a := testApp(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(429)
		fmt.Fprint(w, `{"error":"test-secret-private"}`)
	})
	result := postChat(a, `{"messages":[{"role":"user","content":"Oi"}]}`)
	if result.Code != 429 || strings.Contains(result.Body.String(), "test-secret") {
		t.Fatal("upstream errors must be sanitized", result.Body.String())
	}
	a.cfg.apiKey = ""
	result = postChat(a, `{"messages":[{"role":"user","content":"Oi"}]}`)
	if result.Code != 503 || !strings.Contains(result.Body.String(), "OPENAI_API_KEY") {
		t.Fatal("missing key must be actionable")
	}
}

func TestAllowedOrigins(t *testing.T) {
	a := testApp(t, func(w http.ResponseWriter, r *http.Request) {})
	for _, tc := range []struct {
		origin string
		want   int
	}{{"https://unknown.example", 403}, {"http://localhost:5173", 200}, {"http://example.com", 200}} {
		r := httptest.NewRequest("GET", "/api/health", nil)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		a.routes().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("origin %s: got %d", tc.origin, w.Code)
		}
	}
}

func TestStreamFailuresAreNotSuccessful(t *testing.T) {
	for _, data := range []string{
		`data: {"type":"response.output_text.delta","delta":"partial"}` + "\n\n",
		`data: {"type":"response.incomplete"}` + "\n\n",
		`data: {"type":"response.failed"}` + "\n\n",
		`data: {"type":"error"}` + "\n\n",
		`data: {"type":"response.completed"}` + "\n\n",
		"data: invalid\n\n", "data: [DONE]\n\n",
	} {
		if err := relayStream(strings.NewReader(data), func(any) error { return nil }); err == nil {
			t.Errorf("expected stream failure for %q", data)
		}
	}
}

func TestClientCancellationCancelsUpstream(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	a := testApp(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.created\"}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-r.Context().Done():
			close(canceled)
		case <-time.After(3 * time.Second):
		}
	})
	server := httptest.NewServer(a.routes())
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/chat", strings.NewReader(`{"messages":[{"role":"user","content":"Oi"}]}`))
	r.Header.Set("Content-Type", "application/json")
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	<-started
	cancel()
	select {
	case <-canceled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was not canceled")
	}
}

func TestStaticBuildIsServed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>Vamo</h1>"), 0600); err != nil {
		t.Fatal(err)
	}
	a := &application{cfg: config{dist: dir}}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Vamo") {
		t.Fatal("static frontend not served")
	}
	w = httptest.NewRecorder()
	a.routes().ServeHTTP(w, httptest.NewRequest("GET", "/api/unknown", nil))
	if w.Code != 404 {
		t.Fatal("unknown API route must be 404")
	}
}

func TestRelayHandlesMultilineEventAndRefusal(t *testing.T) {
	input := "data: {\"type\":\"response.refusal.delta\",\r\ndata: \"delta\":\"Não posso.\"}\r\n\r\ndata: {\"type\":\"response.completed\"}"
	count := 0
	if err := relayStream(strings.NewReader(input), func(any) error { count++; return nil }); err != nil || count != 2 {
		t.Fatalf("multiline stream: %v, events=%d", err, count)
	}
	if err := relayStream(io.NopCloser(strings.NewReader("data: {}\n\n")), func(any) error { return nil }); err == nil {
		t.Fatal("EOF without completion should fail")
	}
}
