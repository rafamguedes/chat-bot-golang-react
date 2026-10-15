package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const maxBody = 256 * 1024

type config struct {
	apiKey, model, baseURL, address, dist string
	origins                               map[string]bool
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type application struct {
	cfg    config
	client *http.Client
}

func main() {
	if err := loadEnv(".env"); err != nil {
		log.Fatal(err)
	}
	port := env("PORT", "8080")
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		log.Fatal("PORT deve ser um número entre 1 e 65535")
	}
	cfg := config{
		apiKey:  strings.TrimSpace(os.Getenv("OPENAI_API_KEY")),
		model:   env("OPENAI_MODEL", "gpt-5.4-mini"),
		baseURL: "https://api.openai.com/v1", address: net.JoinHostPort(env("HOST", "127.0.0.1"), port),
		dist: env("FRONTEND_DIST", "../frontend/dist"), origins: make(map[string]bool),
	}
	for _, origin := range strings.Split(env("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"), ",") {
		cfg.origins[strings.TrimSpace(origin)] = true
	}
	app := &application{cfg: cfg, client: &http.Client{Timeout: 3 * time.Minute}}
	server := &http.Server{
		Addr: cfg.address, Handler: app.routes(), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, WriteTimeout: 190 * time.Second, IdleTimeout: 60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Vamo em http://%s · modelo %s · chave configurada: %t", cfg.address, cfg.model, cfg.apiKey != "")
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "configured": a.cfg.apiKey != "", "model": a.cfg.model})
	})
	mux.HandleFunc("POST /api/chat", a.chat)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "Endpoint não encontrado.")
	})
	files := http.FileServer(http.Dir(a.cfg.dist))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, "Método não permitido.")
			return
		}
		if _, err := os.Stat(filepath.Join(a.cfg.dist, "index.html")); err != nil {
			writeError(w, http.StatusNotFound, "Interface ainda não compilada. Execute npm run build em frontend ou use o Vite na porta 5173.")
			return
		}
		files.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Cache-Control", "no-store")
		if origin := r.Header.Get("Origin"); origin != "" {
			sameOrigin := origin == "http://"+r.Host || (r.TLS != nil && origin == "https://"+r.Host)
			if !sameOrigin && !a.cfg.origins[origin] {
				writeError(w, http.StatusForbidden, "Origem não autorizada.")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *application) chat(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		writeError(w, http.StatusUnsupportedMediaType, "Envie um corpo JSON.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	defer r.Body.Close()
	var input struct {
		Messages []message `json:"messages"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "Conversa muito grande. Inicie uma nova conversa.")
		} else {
			writeError(w, http.StatusBadRequest, "O corpo da mensagem é inválido.")
		}
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "Envie somente um objeto JSON.")
		return
	}
	if err := validateMessages(input.Messages); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if a.cfg.apiKey == "" {
		writeError(w, http.StatusServiceUnavailable, "Adicione OPENAI_API_KEY ao arquivo backend/.env e reinicie o servidor para começar.")
		return
	}
	if _, ok := w.(http.Flusher); !ok {
		writeError(w, http.StatusInternalServerError, "Streaming indisponível neste servidor.")
		return
	}
	payload, err := json.Marshal(map[string]any{
		"model": a.cfg.model, "input": input.Messages, "stream": true, "store": false,
		"max_output_tokens": 4096,
		"instructions":      "Você é Vamo, um assistente prestativo, claro e gentil. Responda em português do Brasil, a menos que o usuário peça outro idioma. Use Markdown quando ajudar a leitura. Seja direto e honesto sobre incertezas. Não diga que executou ações que não executou.",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Não foi possível preparar a mensagem.")
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, a.cfg.baseURL+"/responses", bytes.NewReader(payload))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Configuração da API inválida.")
		return
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	response, err := a.client.Do(request)
	if err != nil {
		if r.Context().Err() == nil {
			writeError(w, http.StatusBadGateway, "Não foi possível conectar à OpenAI. Tente novamente em instantes.")
		}
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		log.Printf("OpenAI status=%d request_id=%s", response.StatusCode, response.Header.Get("X-Request-Id"))
		status, text := upstreamError(response.StatusCode)
		writeError(w, status, text)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	_ = http.NewResponseController(w).Flush()
	if err := relayStream(response.Body, func(event any) error { return sendEvent(w, event) }); err != nil && r.Context().Err() == nil {
		_ = sendEvent(w, map[string]string{"type": "error", "error": err.Error()})
	}
}

func validateMessages(messages []message) error {
	if len(messages) == 0 || len(messages) > 100 {
		return errors.New("Envie entre 1 e 100 mensagens. Inicie uma nova conversa se atingir o limite.")
	}
	total := 0
	for _, m := range messages {
		if m.Role != "user" && m.Role != "assistant" {
			return errors.New("Papel de mensagem inválido.")
		}
		if strings.TrimSpace(m.Content) == "" || len([]rune(m.Content)) > 16000 {
			return errors.New("Cada mensagem deve ter entre 1 e 16.000 caracteres.")
		}
		total += len(m.Content)
	}
	if total > 120000 {
		return errors.New("Conversa muito grande. Inicie uma nova conversa.")
	}
	if messages[len(messages)-1].Role != "user" {
		return errors.New("A última mensagem deve ser do usuário.")
	}
	return nil
}

// OpenAI's SSE events are translated to a small browser-facing protocol.
func relayStream(body io.Reader, emit func(any) error) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	var data []string
	completed := false
	hasText := false
	dispatch := func() error {
		if len(data) == 0 {
			return nil
		}
		payload := strings.Join(data, "\n")
		data = nil
		if payload == "[DONE]" {
			return nil // Only response.completed confirms that generation succeeded.
		}
		var event struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
		}
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			return errors.New("A OpenAI enviou uma resposta inválida. Tente novamente.")
		}
		switch event.Type {
		case "response.output_text.delta", "response.refusal.delta":
			if event.Delta != "" {
				hasText = true
				return emit(map[string]string{"type": "delta", "delta": event.Delta})
			}
		case "response.completed":
			if !hasText {
				return errors.New("O modelo não retornou texto. Tente reformular sua mensagem.")
			}
			completed = true
			return emit(map[string]string{"type": "done"})
		case "error", "response.failed":
			return errors.New("A OpenAI não conseguiu concluir a resposta. Tente novamente.")
		case "response.incomplete":
			return errors.New("A resposta ficou incompleta. Tente pedir uma resposta mais curta.")
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			if completed {
				return nil
			}
		} else if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return errors.New("A conexão foi interrompida. Tente novamente.")
	}
	if err := dispatch(); err != nil {
		return err
	}
	if !completed {
		return errors.New("A conexão terminou antes de concluir a resposta. Tente novamente.")
	}
	return nil
}

func sendEvent(w http.ResponseWriter, event any) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
		return err
	}
	return http.NewResponseController(w).Flush()
}

func upstreamError(status int) (int, string) {
	switch status {
	case 401, 403:
		return http.StatusBadGateway, "Confira a chave da OpenAI e a permissão para o modelo no backend."
	case 429:
		return http.StatusTooManyRequests, "A OpenAI atingiu um limite de uso ou saldo. Confira sua conta e tente novamente."
	case 400, 404:
		return http.StatusBadGateway, "Confira OPENAI_MODEL e o acesso a esse modelo na sua conta."
	default:
		return http.StatusBadGateway, "A OpenAI está indisponível no momento. Tente novamente em instantes."
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, text string) {
	writeJSON(w, status, map[string]string{"error": text})
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func loadEnv(path string) error {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "\ufeff"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if !ok || key == "" {
			return errors.New("Linha inválida no arquivo .env; use CHAVE=valor")
		}
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			if err := os.Setenv(key, value); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}
