# OrgForge 知识库接入进度

> 数据集:[`aeriesec/orgforge`](https://huggingface.co/datasets/aeriesec/orgforge)
> 最后更新:2026-09-26 · 状态:**全量 ingestion + 确定性图已完成并验证;embedding 待 Bedrock 账号放行**

---

## 1. 架构:一次 ingestion,两层用途

`source_documents` 装全量语料,下游按 `category` 分流:

```
全量 22,530 行 → source_documents
   │
   ├─ artifact (4,988)   → document_chunks (+embedding)  → 检索层
   │                     → document_links                → related() 证据链补全
   │
   └─ sim_event (17,542) → 不切块、不 embed              → 永不进检索
      + sim_config (1)
                         ↓
            graph_nodes / graph_edges(全量)→ scheduler 因果链 · 图②导出
```

**为什么这样分**:artifact 是员工真实可见的工件(jira / slack / confluence / email / PR / zoom 转写);
sim_event 是模拟器事件流,`facts` 里带 `causal_chain`、`spawned_pr` 等**上帝视角信息**。
因果链是 scheduler 要推理的东西,所以 sim_event 必须入库;但它**绝不能成为检索证据**,
所以只有 artifact 会被切块和 embed。这道闸门在 `is_retrievable_artifact()`,并由审计查询守住。

### 与 Letta memory 的关系(双轨,互不混用)

| 轨道 | 存储 | 放什么 |
| :--- | :--- | :--- |
| 个人记忆 | Letta **memfs**(Markdown 文件) | 老板指示、偏好、日程 —— 少量、会被修正 |
| 公司知识 | Postgres(`source_documents` / `document_chunks`) | orgforge artifact —— 大量、只读、可检索 |
| 因果结构 | Postgres(`graph_nodes` / `graph_edges`) | 全量,供 scheduler 与图②导出 |
| 涌现认知 | cognee + Kuzu(未开始) | artifact 子集,LLM 抽取 + 可视化 |

**注意**:本项目的 Letta 用的是 Agent SDK 的 `memfs`(`letta-memory.ts` 里 `memfs: true`),
**没有**经典 Letta 的 core / recall / archival 三层,也没有向量 passages。
所以 orgforge **不进 Letta**,而是进 Postgres,agent 通过 `CompanyKnowledge` 工具接口去查。

---

## 2. 检索层(队友实现,已可用)

`src/adapters/postgres-company-knowledge.ts`:

- `search()` —— **混合检索**:关键词(`tsvector` + `ts_rank_cd`)与语义(pgvector `<=>`)
  各自取 top-k,再用 **Reciprocal Rank Fusion**(`fuseEvidence`,k=60)融合。
  嵌入服务不可用时自动降级为纯关键词,不会整体失败。
- `related()` —— 沿 `document_links` **双向**扩展,这就是"证据链补全"路径。
- `sources()` —— 按 id 取原文。

**关键词检索现在就能用,不依赖 Bedrock。** 语义那一半要等 embedding 落地。

### 检索路由(设计,未实现)

共同骨架"先语义、再按需图",按问题类型分三路:

| 问题形态 | 策略 |
| :--- | :--- |
| 「A 和 B 怎样相关?」「这个结论的证据链是什么?」 | chunk 检索 → 沿 `references` 递归游走补全证据链 |
| 「某人/项目目前怎样?」「这个主题有什么规律?」 | 实体/关系检索 → 展开 `involves`/`references` 邻域 → 按时间/部门结构化归纳 |
| 简单事实查找 | 纯向量 top-k,**不碰图** |

---

## 3. 环境

| 组件 | 状态 |
| :--- | :--- |
| Postgres | **Docker** `pgvector/pgvector:pg16`,宿主端口 **5433** |
| Postgres.app(17.6) | 保留在 5432,与容器共存 |
| pgvector / pg_trgm | 随镜像提供 |
| Python | `.venv` 3.12.14 · `psycopg[binary]==3.2.10` · `datasets==4.1.1` |
| Node | `npm ci` 已装(`pg`、`tsx`) |

`DATABASE_URL=postgresql://orgforge:orgforge-local@localhost:5433/orgforge`

**端口 5433 的由来**:Postgres.app 已占 5432。用 `docker-compose.override.yml`(本地专用,已 gitignore)
改端口,不动团队共享的 `docker-compose.yml`。
其中 `ports: !override` 是必须的 —— Compose 对列表默认**追加**,少了这个标签容器会**同时**绑 5432,
导致连 5432 时可能命中错误的服务器。

---

## 4. 运行步骤

```bash
export DATABASE_URL="postgresql://orgforge:orgforge-local@localhost:5433/orgforge"

docker compose up -d database                       # 起库(healthy 约 4s)
npx tsx scripts/migrate.ts                          # migration 001–005
.venv/bin/python scripts/orgforge/ingest.py         # 全量 ingestion(约 1m10s)
.venv/bin/python orgforge_kb/build_graph.py         # 建图(约 1.3s),可加 --reset

npx tsx scripts/orgforge/embed.ts --dry-run         # 成本预检(不调用 API)
npx tsx scripts/orgforge/embed.ts                   # embedding 回填(待放行)
```

`migrate.ts` **每次重跑所有 migration**,所以 migration 必须幂等(005 全部 `IF NOT EXISTS`)。
ingestion 与建图都是幂等 upsert,可反复重跑。

---

## 5. 关键文件

| 文件 | 作用 |
| :--- | :--- |
| `database/migrations/001_company_context.sql` | `source_documents` / `document_chunks` / `document_links` / `employees` |
| `database/migrations/002_company_embeddings.sql` | chunk 上的 `embedding vector(1024)` + HNSW cosine 索引 |
| `database/migrations/005_orgforge_full_corpus.sql` | `source_documents.category`;`actors` / `document_actors`;`graph_nodes` / `graph_edges` |
| `scripts/orgforge/ingest.py` | parser + chunker + 全量 ingestion |
| `scripts/orgforge/embed.ts` | Bedrock embedding 回填(增量 + 预算护栏) |
| `orgforge_kb/build_graph.py` | 确定性图构建(零 LLM) |
| `src/adapters/postgres-company-knowledge.ts` | 混合检索 + 证据链补全 |
| `docs/OrgForge_Database_Schema.sql` | **仅供设计参考**;权威 schema 是 `database/migrations/` |

图节点用**自然键**:`graph_nodes.ref_key` 存 `source_id`(文档)或 actor 名字。
边只在**两端都能解析成节点**时才建,所以路径类引用(`eml_path`、`slack_path`、`artifact_path`、
`embed_id`、`source_email`)自动被丢弃,图中**没有悬空边**。

---

## 6. 验证结果(2026-09-26 实测)

```
source_documents            22,530
  artifact                   4,988   → document_chunks 7,526
  sim_event                 17,541   → 0 chunks
  sim_config                     1   → 0 chunks
category IS NULL                 0

graph_nodes                 22,606   (document 22,530 + actor 76)
graph_edges                 58,366   (involves 47,428 + references 10,938)
悬空边                            0
document_links              16,502

document_chunks 已 embed      0 / 7,526   ← 待 Bedrock 放行
```

**Oracle 安全**:`document_chunks` 里只有 `category='artifact'`,sim_event 一条都没有。
关键词检索实测 top-5 全部是 artifact,边界在实践中也成立。

**因果链遍历**(递归 CTE,带深度与环保护),种子 `EVT-1-sprint_planned-49`:
深度 0/1/2 分别命中 1 / 28 / 1 个节点。

审计查询:

```sql
-- Oracle 安全:必须只返回 artifact 一行
SELECT d.category, count(DISTINCT c.source_id), count(*)
FROM document_chunks c JOIN source_documents d USING (source_id)
GROUP BY d.category;

-- category 推导完整性:必须为 0
SELECT count(*) FROM source_documents WHERE category IS NULL;

-- 悬空边:必须为 0
SELECT count(*) FROM graph_edges e
LEFT JOIN graph_nodes s ON s.node_id = e.src_node_id
LEFT JOIN graph_nodes d ON d.node_id = e.dst_node_id
WHERE s.node_id IS NULL OR d.node_id IS NULL;
```

---

## 7. 数据坑(已在代码中处理)

语料里有三类只在**全量规模**才暴露的问题:

1. **`category` 缺失**:6,622 行为空(datadog_metric 5,760、dept_plan 420、dept_plan_reasoning 420,
   及少量 artifact)。`derive_category()` 按 doc_type 推导,否则下游分流失效。
2. **NUL 字节**:少数正文含 `0x00`,Postgres text/jsonb 拒收 → `without_nul()` / `dump_json()` 清除。
3. **日期格式不一致**:1 行用 Unicode 连字符(U+2011);5,760 行(datadog_metric)的 `date`/`timestamp`
   是 **Unix 时间戳字符串**(如 `1767225600`)而非 ISO。`parse_date()` / `parse_timestamp()` 处理。

`artifact_ids` 的真实形态:10,323 行有交叉引用,值多为单个字符串、446 个是数组;
键既有文档引用(`jira` 5,098、`slack_thread` 3,921、`confluence` 1,897 …),
也有文件路径(`eml_path`、`slack_path` …),后者不构成图边。

---

## 8. 待办

- [ ] **Embedding 回填** —— 被 **Bedrock 账号级 allowlisting** 阻塞。
      报错 `ValidationException: must verify you are a corporate customer`,需提
      `bedrock-allowlisting` support case(hackathon 账号建议直接找主办方)。
      **这不是代码或凭证问题** —— 请求已成功到达 AWS。
- [ ] **统一 AWS 认证方式** —— 团队 `.env.example` 用 `AWS_PROFILE=sme-agent` + `aws login`,
      并注明「never put AWS access keys in this file」;而当前手上是 Bedrock bearer token。
      需与队友对齐。团队 region 为 `ap-southeast-2`。
- [ ] 实现检索路由三条路径(§2)
- [ ] 图②:装 cognee(`pip install "cognee[gliner]"`,venv 3.12 满足要求),
      用 artifact 子集建 Kuzu 图做可视化与涌现关系;LLM 拟用云端 Qwen 或 DeepSeek(均 OpenAI 兼容)
- [ ] 补充数据尚未接入:`domain_registry.json`、`simulation_snapshot.json`、
      `assignment_scores.parquet`、`datadog_metrics.parquet`
      (对应 `graph_edges` 里预留的 `owns_domain` / `triggered_by` / `part_of` 边)
