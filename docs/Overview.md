
# Relay — Overview

## Vision
Relay is a production-inspired webhook delivery platform that guarantees durable event storage while maintaining predictable memory usage.

## Core Idea
Unlike traditional webhook platforms that continuously keep retry jobs inside the queue, Relay separates storage from execution.

- PostgreSQL stores every event permanently.
- Redis is **not** permanent storage.
- Redis acts as an **Execution Window** that contains only the next **5,000** executable jobs.

This prevents Redis from growing indefinitely even if a customer is offline for days.

## Problem
A customer may generate millions of webhook events while their endpoint is unavailable.

Keeping all pending events inside Redis wastes memory and eventually becomes a bottleneck.

## Relay Solution

1. Store every incoming event in PostgreSQL.
2. Scheduler continuously maintains an Execution Window of 5,000 jobs in Redis.
3. Workers consume jobs from Redis.
4. Failed deliveries are marked WAITING in PostgreSQL.
5. Scheduler later re-adds eligible WAITING jobs back into Redis.
6. Redis never stores every pending event.

## Why this architecture?
- Predictable Redis memory usage
- Durable storage
- Easy replay
- Horizontal scalability
- Clear separation of responsibilities