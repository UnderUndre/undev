---
name: architecture
description: Architectural decision-making framework. Requirements analysis, trade-off evaluation, ADR documentation. Use when making architecture decisions or analyzing system design.
allowed-tools: Read, Glob, Grep
---

# Architecture Decision Framework

> "Requirements drive architecture. Trade-offs inform decisions. ADRs capture rationale."

## 🏗️ System Design Blueprint (Alex Xu Standards)

Практические правила построения масштабируемых веб-архитектур.

### 1. Scaling from Zero to Millions
- **Stateless Web Tier**: Серверы не должны хранить состояние сессий. Состояние — в Redis/Memcached.
- **Redundancy**: Избегай SPOF (Single Point of Failure). Реплицируй данные, дублируй сервисы за балансировщиками.
- **Caching**: Кэш для частых чтений. CDN для статики.

### 2. Decoupling & Asynchronous Processing
- **Message Queues**: Используй брокеры (RabbitMQ, SQS, Kafka) как буфер при пиковых нагрузках.
- **DAG Processing**: Тяжелые задачи разбивай на графы и обрабатывай параллельно через очереди.

### 3. API Protection
- **Rate Limiting**: Защищай публичные API от DDoS и парсеров (Token Bucket/Sliding Window).

### 4. Data Distribution
- **Consistent Hashing**: При шардировании кэша используй консистентное хеширование с виртуальными нодами.
- **Delta Sync**: При синхронизации больших файлов передавай только измененные блоки (chunks).

---

## 🎯 Selective Reading Rule

**Read ONLY files relevant to the request!** Check the content map, find what you need.

| File | Description | When to Read |
|------|-------------|--------------|
| `context-discovery.md` | Questions to ask, project classification | Starting architecture design |
| `trade-off-analysis.md` | ADR templates, trade-off framework | Documenting decisions |
| `pattern-selection.md` | Decision trees, anti-patterns | Choosing patterns |
| `examples.md` | MVP, SaaS, Enterprise examples | Reference implementations |
| `patterns-reference.md` | Quick lookup for patterns | Pattern comparison |

---

## 🔗 Related Skills

| Skill | Use For |
|-------|---------|
| `@[skills/database-design]` | Database schema design |
| `@[skills/api-patterns]` | API design patterns |
| `@[skills/deployment-procedures]` | Deployment architecture |

---

## Core Principle

**"Simplicity is the ultimate sophistication."**

- Start simple
- Add complexity ONLY when proven necessary
- You can always add patterns later
- Removing complexity is MUCH harder than adding it

---

## Validation Checklist

Before finalizing architecture:

- [ ] Requirements clearly understood
- [ ] Constraints identified
- [ ] Each decision has trade-off analysis
- [ ] Simpler alternatives considered
- [ ] ADRs written for significant decisions
- [ ] Team expertise matches chosen patterns
