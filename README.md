# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录和封存交付记录。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks?qualified=&sealed=`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id`（详情，结论与列表、历史一致）
- `GET /clocks/:id/history`（含调校、复测、封存历史和统一结论）
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `POST /clocks/:id/seals`（登记封存交付）
- `GET /clocks/:id/seals?status=valid|invalidated`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`
- `GET /seals?clockId=&status=&sealed=`

## 封存交付闭环规则

1. **封存资格**：仅当该钟表「当前最新调校之后的最新复测」满足
   `|日差| ≤ targetDailyRateSeconds` 且 `180 ≤ 振幅 ≤ 320` 时才能登记封存；
   最新调校后尚无复测、日差超目标或振幅越界均返回 `400` 且不写入。
2. **交付凭证**：`POST /clocks/:id/seals` 必须提供 `sealTag`（唯一封签）和
   `deliveredBy`（交付人），封存记录同时固定复测快照。
3. **封签唯一**：封签号全局唯一，重复登记返回 `409` 且不写入任何记录；
   已有有效封存未失效时再次封存同样返回 `409`。
4. **封存失效**：封存后再次创建调校记录，原封存立即置为 `invalidated`
   （记录失效时间和触发调校），钟表状态自动回到 `pending-retest`；
   旧封存记录保留，可通过历史接口和 `GET /seals` 查询。
5. **筛选与一致性**：`GET /clocks?sealed=true` 只返回当前持有有效封存的钟表；
   列表、详情、历史中的 `status / statusReason / sealed / qualified /
   activeSeal` 由同一结论函数计算，保证口径一致。

状态取值：`sealed`（已封存交付）、`qualified`（复测合格待封存）、
`pending-retest`（待复测）、`not-qualified`（复测不合格）、`unadjusted`（未调校）。

## 闭环示例

```bash
# 1. 最新复测合格（日差进目标、振幅180-320）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'

# 2. 登记封存交付
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/seals \
  -H 'Content-Type: application/json' \
  -d '{"sealTag":"SEAL-2026-0001","deliveredBy":"王师傅","note":"交付客户"}'

# 3. 查询已封存钟表
curl 'http://127.0.0.1:3021/clocks?sealed=true'

# 4. 封存后再次调校 -> 封存失效、回到待复测
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":15,"direction":"慢针方向","amount":"复查微调0.1格"}'
```
