# vamo — chatbot com Go, React e OpenAI

Uma aplicação local de chat em português. Backend em Go usando somente a biblioteca padrão; frontend em React, TypeScript e Vite.

## Como funciona

- Respostas em streaming pela Responses API da OpenAI.
- Contexto da conversa enviado a cada mensagem e botão para interromper a geração.
- Markdown, tabelas e blocos de código nas respostas.
- Histórico local com busca, exclusão e exportação em Markdown.
- Interface responsiva, sugestões de perguntas e configurações de conexão.
- Tratamento de chave ausente, limite de uso, modelo indisponível, falhas e respostas incompletas.

## Começar no Windows

O pacote ZIP da entrega inclui a interface compilada e `backend/vamo-chat.exe` para Windows x64. Para executar essa versão, não é necessário instalar Go ou Node. Esses arquivos compilados não são versionados no Git; ao clonar o repositório, siga a seção de desenvolvimento ou compile a aplicação antes de executar `iniciar.cmd`.

1. Copie `backend/.env.example` para `backend/.env`.
2. Preencha `OPENAI_API_KEY` nesse arquivo com uma chave da sua conta: [gerenciar chaves](https://platform.openai.com/api-keys).
3. Execute `iniciar.cmd` e mantenha o terminal aberto.
4. Acesse <http://127.0.0.1:8080>.

O modelo inicial é `gpt-5.4-mini`. Você pode trocar `OPENAI_MODEL` por um modelo compatível com Responses e disponível na sua conta. A API exige uma chave e saldo próprios. Sem chave, a interface abre e explica a configuração; nenhuma resposta é simulada.

## Desenvolver a partir do código

Requisitos: Go 1.23 ou superior; Node 22.12 ou superior (ou 20.19+), com npm. Use uma versão do Go ainda suportada para novas instalações.

No primeiro terminal, na pasta `backend`:

```powershell
Copy-Item .env.example .env
# Edite .env e adicione a chave. Não a coloque no frontend.
go run .
```

No segundo terminal, na pasta `frontend`:

```powershell
npm ci
npm run dev
```

Abra <http://127.0.0.1:5173>. O Vite encaminha `/api` ao Go na porta 8080. Se alterar a porta do backend, ajuste também `frontend/vite.config.ts`.

## Compilar uma nova versão

Na pasta `frontend`:

```powershell
npm ci
npm run build
```

Na pasta `backend`:

```powershell
go build -trimpath -o vamo-chat.exe .
```

O Go serve os arquivos de `frontend/dist` e a API no mesmo endereço. A execução deve começar na pasta `backend`, como faz `iniciar.cmd`. Em Linux/macOS, compile com `go build -o vamo-chat .` e execute `./vamo-chat` nessa pasta.

## Configuração do backend

| Variável | Padrão | Uso |
| --- | --- | --- |
| `OPENAI_API_KEY` | vazio | Chave da OpenAI, somente no servidor |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Modelo para a geração |
| `HOST` | `127.0.0.1` | Interface de rede local |
| `PORT` | `8080` | Porta HTTP |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origens adicionais autorizadas, separadas por vírgula |
| `FRONTEND_DIST` | `../frontend/dist` | Caminho dos arquivos compilados |

O arquivo `.env` é lido ao iniciar. Variáveis já existentes no ambiente têm prioridade. Reinicie o servidor após alterar a chave ou o modelo.

## API

`GET /api/health` informa se o servidor está ativo, o modelo e se há uma chave configurada. Não faz uma chamada paga nem confirma a validade da chave.

`POST /api/chat`, com `Content-Type: application/json`:

```json
{
  "messages": [
    { "role": "user", "content": "Me ajude a organizar uma ideia." }
  ]
}
```

Em caso de sucesso, retorna SSE:

```text
data: {"type":"delta","delta":"Vamos começar!"}

data: {"type":"done"}

```

Erros anteriores ao streaming retornam HTTP 4xx/5xx com `{"error":"mensagem"}`. Erros durante a geração retornam um evento `{"type":"error","error":"mensagem"}`. Uma resposta só é considerada concluída após `done`. O cancelamento no navegador também cancela a requisição à OpenAI.

Limites: até 100 mensagens por requisição; 16.000 caracteres por mensagem; 120.000 bytes de conteúdo por conversa; corpo HTTP de 256 KiB; até 4.096 tokens de saída. Ao atingir um limite, inicie uma conversa nova. O frontend não descarta silenciosamente o começo da conversa para caber no contexto.

## Dados e escopo

O histórico fica no `localStorage` deste navegador, limitado a 30 conversas. Não há sincronização ou banco de dados. Quando uma nova conversa ultrapassa esse limite, a mais antiga da lista é removida; exporte o que quiser guardar. Excluir uma conversa remove o histórico local.

As mensagens e o contexto são enviados à OpenAI quando você envia uma pergunta. A integração usa `store: false`; isso não substitui as políticas de retenção da API. A chave fica no backend e os arquivos `.env` são ignorados pelo Git. Não distribua sua chave nem a adicione a variáveis `VITE_*`.

Esta base é para uso local, sem autenticação. Para publicar na internet, adicione autenticação, limites por usuário e HTTPS antes de expor o servidor. O backend Go precisa de uma hospedagem que execute Go ou contêineres.

## Verificação

```powershell
# Em backend
go test -v ./...
go vet ./...

# Em frontend
npm test
npm run build
```

Os testes do backend usam um servidor OpenAI simulado para verificar o contrato HTTP, contexto, streaming, erros, cancelamento e proteção da chave. Os testes do frontend verificam o parser de SSE, incluindo texto UTF-8 dividido entre pacotes. Não é preciso uma chave para executar os testes.

## Estrutura

```text
backend/
  main.go             # Servidor HTTP, cliente OpenAI, configuração e streaming
  main_test.go        # Testes de integração locais
  .env.example        # Configuração sem segredos
  vamo-chat.exe       # Executável compilado para Windows x64
frontend/
  src/App.tsx         # Interface e fluxo de conversas
  src/api.ts          # Cliente da API local
  src/lib/sse.mjs     # Parser incremental de eventos
  src/storage.ts      # Histórico no navegador
  src/styles.css      # Layout responsivo
  tests/              # Testes do parser
  dist/               # Interface compilada
iniciar.cmd           # Inicia a versão compilada no Windows
```

Referências: [Responses e streaming](https://developers.openai.com/api/docs/guides/streaming-responses), [modelo configurado](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [React](https://react.dev/reference/react-dom/client/createRoot) e [Vite](https://vite.dev/guide/).
