# How to Run resoFlow

## 1. Quick Start (All Services)
To start everything (PostgreSQL, Redis, FastAPI Backend, Celery Worker, Vite Frontend):

```bash
cd /home/debadutta/Documents/resoFlow
./start_apps.sh
```

- **Web App (Local)**: http://localhost:5173
- **Web App (LAN)**: http://<LAN_IP>:5173
- **API Docs (Swagger)**: http://localhost:8000/docs
- **PostgreSQL**: `localhost:5433` (`resoflow` / `resoflow`)
- **Redis**: `localhost:6380`

---

## 2. Development Mode (Live Logs)
To run with live terminal log streaming:

```bash
./dev.sh
```

---

## 3. Graceful Shutdown

- To stop the application services (Backend, Celery, Frontend) while keeping database containers running for fast restart:
  ```bash
  ./stop_apps.sh
  ```
  *(Or press `Ctrl+C` in the terminal running `./start_apps.sh` / `./dev.sh`)*

- To stop **everything including the database and cache containers**:
  ```bash
  ./stop_apps.sh --all
  ```

- To tear down and remove Docker containers:
  ```bash
  ./stop_apps.sh --down
  ```