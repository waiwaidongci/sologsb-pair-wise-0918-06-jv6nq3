# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录和复测记录。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks?qualified=&sealed=`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `POST /clocks/:id/seal`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`
- `GET /seals?clockId=&status=`

## 封存交付闭环

- **封存门槛**：只有当前调校后的最新复测满足 `|日差| ≤ targetDailyRateSeconds` 且振幅在 `180–320`，才能 `POST /clocks/:id/seal` 登记封存，否则返回 409。
- **封存记录**：必须提供交付人 `deliveredBy` 和唯一封签 `sealTag`；封签全局唯一（含已失效封存），重复返回 409 且不写入。
- **失效**：封存后再次 `POST /clocks/:id/adjustments` 立即使当前封存失效（`status: invalidated`，保留可查），钟表回到 `pending_retest` 待复测状态。
- **一致结论**：列表、详情、历史统一返回 `sealed` / `status` / `sealable` / `activeSeal`；`GET /clocks?sealed=true` 只列出当前封存有效的钟表。
- 钟表状态：`sealed`（已封存）→ 再调校 → `pending_retest`（待复测）→ 复测后 `qualified` / `unqualified`。

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/seal \
  -H 'Content-Type: application/json' \
  -d '{"deliveredBy":"王师傅","sealTag":"SEAL-2026-0001"}'
curl 'http://127.0.0.1:3021/clocks?sealed=true'
curl 'http://127.0.0.1:3021/seals?clockId=clock_demo'
```
