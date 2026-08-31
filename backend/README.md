# resoFlow Backend

## Database Migrations

resoFlow uses [Alembic](https://alembic.sqlalchemy.org/) for database schema migrations.

### Running Migrations

To apply all pending database migrations to the configured database:

```bash
uv run alembic upgrade head
```

### Creating New Migrations

When modifying SQLAlchemy models in `app/models.py`, generate a new migration revision:

```bash
uv run alembic revision --autogenerate -m "description_of_changes"
```

Review the generated migration script in `migrations/versions/` and apply it:

```bash
uv run alembic upgrade head
```

### Checking Current Migration Status

```bash
uv run alembic current
```
