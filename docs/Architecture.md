
# Relay — Architecture

## High-Level Architecture

Client
  |
API Server
  |
PostgreSQL (Source of Truth)
  |
Scheduler
  |
Redis Execution Window (5,000 jobs max)
  |
Worker Pool
  |
Destination Webhook

## Components

### API Server
- Authenticate request
- Validate payload
- Save event to PostgreSQL
- Never sends webhooks

### PostgreSQL
Stores:
- Users
- Projects
- Webhooks
- Events
- Delivery status

Every event always exists here.

### Scheduler

Runs continuously.

Responsibilities:
- Count jobs currently in Redis
- If jobs < 5000:
    - Query eligible PENDING/WAITING events
    - Push IDs into Redis
- Skip events already queued

### Redis Execution Window

Maximum Capacity:
5000 jobs

Purpose:
- Keep workers busy
- Bound memory usage
- Fast coordination

Redis stores only:
- Event ID
- Attempt number
- Metadata required for execution

### Workers

Worker lifecycle:

1. Pop event ID
2. Read full event from PostgreSQL
3. Deliver webhook
4. Update event status

On success:
DELIVERED

On failure:
WAITING
next_retry_at = calculated time

Redis entry removed immediately.

### Retry Model

Relay does not keep failed jobs inside Redis.

Instead:

Failure
  |
Update PostgreSQL
  |
Status = WAITING
  |
Scheduler later moves it back into Redis when eligible.

This keeps Redis bounded.

## Why no infinite queue?

Suppose customer produces:
10,000 events/hour

After one week:
1.68 million events.

Those remain safely in PostgreSQL.

Redis still contains only the current execution window of 5,000 jobs.

## Scaling

API Servers -> Horizontal
Workers -> Horizontal
Redis -> Execution Window
PostgreSQL -> Durable event store