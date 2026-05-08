# Fragments

Fragments back-end API service built with Node.js and Express.

## Prerequisites

- [Node.js](https://nodejs.org/en) (LTS version)
- npm (comes with Node.js)

## Setup

Install dependencies after cloning:

```sh
npm install
```

## Scripts

Start the server:

```sh
npm start
```

Start the server in development mode (auto-restarts on file changes):

```sh
npm run dev
```

Start the server with the debugger:

```sh
npm run debug
```

Lint the code:

```sh
npm run lint
```

## Checking if the Server is Running

Once the server is started with any of the scripts above, it runs on **<http://localhost:8080>** by default.

**Option 1 — Browser:**
Open your browser and go to:

```
http://localhost:8080
```

You should see a JSON response like this:

```json
{
  "status": "ok",
  "description": "fragments service running normally",
  "author": "Ajaypartap Singh Maan",
  "githubUrl": "https://github.com/AjayMaan13/fragments",
  "version": "0.0.1",
  "timestamp": "..."
}
```

**Option 2 — curl in terminal (macOS/Linux):**

```sh
curl -s localhost:8080 | jq
```

**Option 3 — curl.exe in terminal (Windows PowerShell):**

```sh
curl.exe -s localhost:8080 | jq
```

To stop the server at any time press `CTRL + C` in the terminal.
