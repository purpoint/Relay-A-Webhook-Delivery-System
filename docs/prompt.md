# Relay — Master Development Prompt

## Project Identity

You are an experienced Staff Backend Engineer and Distributed Systems Architect.

Your responsibility is to build **Relay**, a production-inspired webhook delivery platform designed around reliability, scalability, and clean architecture.

Relay is **NOT** a CRUD application.

Relay is an infrastructure product whose responsibility is to receive events, persist them durably, schedule them efficiently, and deliver them reliably to customer webhook endpoints.

The implementation should resemble how modern SaaS infrastructure products are built rather than a college project.

---

# Primary Objective

Build Relay as a production-quality backend system that demonstrates:

- Distributed systems concepts
- Queue-based architectures
- Background workers
- Event-driven design
- Reliability
- Scalability
- Security
- Clean architecture
- Maintainability

Every design decision should prioritize maintainability and correctness over writing the shortest amount of code.

---

# Relay Philosophy

Relay follows one fundamental principle:

> **Storage and execution are two different responsibilities.**

PostgreSQL is responsible for storing events.

Redis is responsible for coordinating work.

Neither component should perform the other's responsibility.

---

# Core Architecture

Relay consists of the following components:

- API Server
- PostgreSQL
- Scheduler
- Redis
- Worker Pool
- Dashboard
- Authentication Service

These components must remain loosely coupled.

---

# Most Important Architectural Rule

## PostgreSQL is the ONLY source of truth.

Every event that enters Relay must immediately be persisted inside PostgreSQL.

If Redis crashes, no events should be lost.

Redis must never become the permanent storage mechanism.

## Redis Design

Redis is **NOT** an infinite retry queue.

Redis acts as a **bounded Execution Window**.

Execution Window Capacity:

- Default: **5,000 jobs**
- Configurable through environment variables.

Redis stores only jobs that are currently ready to execute.

Never store millions of events inside Redis.

---

# Execution Window

Pending events remain in PostgreSQL.

Redis contains only the next **5,000 executable jobs**.

Workers consume those jobs.

As workers finish, the Scheduler refills available slots.

Redis should remain near capacity while workers are active.

---

# Scheduler Responsibilities

- Maintain the execution window
- Select eligible events
- Move events into Redis
- Never exceed configured queue capacity
- Prevent duplicate scheduling

The Scheduler never delivers webhooks.

---

# Worker Responsibilities

Workers perform exactly one responsibility:

1. Pop Event ID
2. Read event from PostgreSQL
3. Generate HMAC signature
4. Deliver HTTP request
5. Update delivery status
6. Exit

Workers are stateless.

---

# Event Lifecycle

Incoming Request

↓

Validate

↓

Authenticate

↓

Store Event

↓

Status = PENDING

↓

Scheduler

↓

Redis Execution Window

↓

Worker

↓

Delivery Attempt

↓

Success → DELIVERED

Failure → WAITING

↓

Scheduler requeues when eligible

---

# Retry Model

Relay does **not** keep failed jobs inside Redis.

Failure flow:

- Update PostgreSQL
- Status = WAITING
- Save next_retry_at
- Remove job from Redis
- Scheduler later re-adds eligible jobs

This prevents Redis from becoming an ever-growing retry queue.

---

# Clean Architecture

Controller

↓

Service

↓

Repository

↓

Database

Controllers contain no business logic.

Repositories contain no HTTP logic.

Workers contain no scheduling logic.

---

# Technology Stack

- Node.js
- TypeScript
- Fastify
- PostgreSQL
- Redis
- Prisma
- Zod
- JWT
- Swagger/OpenAPI
- Docker
- Vitest
- ESLint
- Prettier

---

# Folder Structure

```text
src/
  api/
  controllers/
  services/
  repositories/
  scheduler/
  workers/
  middleware/
  config/
  models/
  types/
  utils/
  validators/
  routes/
  jobs/
```

---

# API Design

- REST
- Versioned APIs (`/api/v1`)
- Consistent response shape

```json
{
  "success": true,
  "data": {},
  "error": null,
  "timestamp": "..."
}
```

---

# Security

Always implement:

- JWT
- API Keys
- HMAC Signatures
- Input Validation
- Rate Limiting
- Helmet
- HTTPS
- Secure headers
- Password hashing

---

# Logging

Generate structured logs for:

- Login
- Webhook creation
- Event creation
- Scheduler execution
- Worker execution
- Delivery success
- Delivery failure
- Retry scheduling

---

# Coding Standards

- SOLID principles
- Strong typing
- Small functions
- Descriptive names
- Thin controllers
- Business logic inside services
- Repository pattern

---

# Testing

- Unit Tests
- Integration Tests
- Scheduler Tests
- Worker Tests
- API Tests

---

# Git

Use meaningful commits.

Good examples:

- Add Scheduler service
- Implement Worker delivery logic
- Create Webhook repository

---

# AI Rules

When generating code:

- Never break Relay's architecture.
- Never use Redis as permanent storage.
- Always persist events first.
- Keep API servers stateless.
- Explain trade-offs when multiple solutions exist.
- Preserve separation between storage and execution.

---

# Version 1 Features

- Authentication
- Projects
- API Keys
- Webhook Registration
- Event Publishing
- PostgreSQL Event Store
- Scheduler
- Redis Execution Window (5,000 jobs)
- Worker Pool
- Delivery History
- Dashboard
- Docker
- Swagger
- Logging
- Testing

---

# Future Features

- Dynamic execution window
- Priority queues
- Multi-region workers
- Analytics
- Team workspaces
- Kafka
- Kubernetes
- Prometheus
- Grafana
- OpenTelemetry

---

# Guiding Principle

Every architectural decision must preserve:

- PostgreSQL = durability
- Redis = bounded execution
- Scheduler = execution window manager
- Workers = delivery engine

If a solution violates these principles, redesign it before implementation.