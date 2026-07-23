# Ultimato do Futuro

Automação para a plataforma **Sala do Futuro** (Seduc-SP).

## O que faz

- ✅ Login com RA / Dígito / Senha
- ✅ Tarefas SP (pendentes, expiradas ou todas) resolvidas por IA
- ✅ Redações geradas por IA com escrita humana
- ✅ Matific (Trabalho Atribuído ou Ilha da Aventura — 20 lições por vez)
- ✅ Seletor de turma (se houver mais de uma)
- ✅ Modo "Fazer Tudo" (tarefas + redações de uma vez)
- ✅ Progresso em tempo real
- ✅ Score/nota exibido por tarefa
- ✅ Histórico de atividades realizadas

## Deploy no Railway

1. Faça fork ou clone deste repositório
2. Conecte no [Railway](https://railway.app) via GitHub
3. Crie um novo projeto → **Deploy from GitHub repo**
4. Adicione a variável de ambiente:
   - `GROQ_API_KEY` = sua chave da API Groq
5. O Railway detecta o `Dockerfile` automaticamente
6. Deploy pronto! ✅

## Rodando localmente

```bash
npm install
npm start
```

Acesse: http://localhost:3000

## Variáveis de ambiente

| Variável | Descrição | Obrigatória |
|---|---|---|
| `PORT` | Porta do servidor (padrão: 3000) | Não |
| `GROQ_API_KEY` | Chave da API Groq para IA | Não (já tem default) |

## Endpoints da API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/login` | Login + retorna turmas |
| `GET` | `/api/tasks` | Lista tarefas pendentes/expiradas |
| `POST` | `/api/complete` | Completa uma tarefa |
| `POST` | `/api/essay` | Gera redação por IA |
| `GET` | `/api/matific` | Lista lições Matific |
| `POST` | `/api/matific/complete` | Completa lição Matific |
| `GET` | `/health` | Health check |

---

> Feito para fins educacionais. Use com responsabilidade.
