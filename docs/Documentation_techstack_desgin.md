
# Relay — Documentation, Tech Stack & Design

## Tech Stack

Backend
- Node.js
- TypeScript
- Fastify

Database
- PostgreSQL

Queue
- Redis
- BullMQ (or custom queue abstraction)

## Design Principles

1. PostgreSQL is the only source of truth.
2. Redis is never permanent storage.
3. API servers remain stateless.
4. Workers perform webhook delivery.
5. Scheduler controls the execution window.

## Folder Structure

src/
  api/
  controllers/
  services/
  scheduler/
  workers/
  repositories/
  middleware/
  config/
  utils/

## Event Lifecycle

Receive Request
|
Save Event (PostgreSQL)
|
Scheduler selects event
|
Redis Execution Window
|
Worker
|
Success -> DELIVERED
Failure -> WAITING in PostgreSQL

## Database Status Values

PENDING
QUEUED
PROCESSING
WAITING
DELIVERED
FAILED

## Scheduler Algorithm

- Target queue size = 5000
- Poll every few seconds
- Fill available slots only
- Never exceed capacity

## Security

- JWT
- API Keys
- HMAC Signatures
- HTTPS
- Rate Limiting
- Input Validation

## Future Improvements

- Dynamic execution window
- Priority queues
- Multi-region workers
- Event partitioning
- Prometheus/Grafana