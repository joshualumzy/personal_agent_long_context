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
| 涌现认知 | cognee(Ladybug 图 + LanceDB 向量,本地文件) | **每个 query 相关的那一小片** artifact,LLM 抽取 + 可视化 |

**注意**:本项目的 Letta 用的是 Agent SDK 的 `memfs`(`letta-memory.ts` 里 `memfs: true`),
**没有**经典 Letta 的 core / recall / archival 三层,也没有向量 passages。
所以 orgforge **不进 Letta**,而是进 Postgres,agent 通过 `CompanyKnowledge` 工具接口去查。

---

## 2. 检索层

`src/adapters/postgres-company-knowledge.ts`。**这一层只返回 artifact**,见下面的安全边界。

- `search()` —— **混合检索**:关键词(`tsvector` + `ts_rank_cd`)与语义(pgvector `<=>`)
  各自取 top-k,再用 **Reciprocal Rank Fusion**(`fuseEvidence`,k=60)融合。
  嵌入服务不可用时自动降级为纯关键词,不会整体失败。
- `related()` —— 沿 `document_links` **双向**扩展,直连证据。
- `relatedThroughEvents()` —— **2 跳**证据补全,见下。可选方法。
- `sources()` —— 按 id 取原文。

### 安全边界:两条路径需要各自过滤

切块闸门保护了 `search()`(`document_chunks` 里只有 artifact),但 `related()` 和 `sources()`
**直接读 `source_documents.body`**,绕过 chunks。全量入库后它们一度会返回
`EVT-*-knowledge_gap_detected` 这类模拟器上帝视角内容 —— 等于把答案泄漏给 agent。
两者现已各自加上 `category = 'artifact'` 过滤,类注释里记录了这个约束。

### 2 跳证据补全(为什么需要)

`document_links` 的两端分布很不均衡:

```
sim_event → artifact   9,947     ← 绝大多数
artifact  → artifact     571
sim_event → sim_event    420
```

事件是**枢纽**:一次决策产生的 jira、slack、confluence、zoom 转写,彼此之间往往
**没有**直连,而是各自被同一个事件引用。所以加了 category 过滤后,`related()` 常常返回空
—— 看起来"什么都不相关",其实是兄弟工件在枢纽另一侧。

`relatedThroughEvents()` 走:**种子的入边 → 造成它的事件 → 事件的出边 → 落到的 artifact**。
事件只被**穿过**,永不返回,所以拿回了可达性而不带回 oracle 信息。固定 2 跳 —— 第三跳
就离开共同起因了,关联不再有意义。

实测 `CONF-ENG-022`(一篇设计文档):直连 artifact **0 条**,穿透后找到 `HR-101`,
正是同一决策产生的工单。

`get_related_sources` 工具在直连结果不足时**自动补足**,所以模型侧仍是一个工具、无需改 prompt。

### 检索路由(设计,未实现)

共同骨架"先语义、再按需图",按问题类型分三路:

| 问题形态 | 策略 |
| :--- | :--- |
| 「A 和 B 怎样相关?」「这个结论的证据链是什么?」 | chunk 检索 → 直连 + 2 跳补全证据链 |
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

## 3.5 Embedding 从何而来(本机 Bedrock 不通)

本机 AWS 账号**未通过 Bedrock 准入审批**,任何模型调用都被拒:

```
ValidationException: To access Amazon Bedrock, you must provide further
information so we can verify you are a corporate customer...
```

`us-east-1` 与团队的 `ap-southeast-2` 报同一个错,bearer token 能被正确读取、
请求也确实到达了 AWS —— **这是账号级行政门槛,不是代码或凭证问题**。

绕过办法:**共享数据库里已有 Titan 向量,把它们拉回本地。**

```
云端共享库(有 7,504 条 Titan 向量,但没有全量语料和图)
      │  只读
      ▼
本地库 5433(有全量 22,530 + 图①)
```

`orgforge_kb/sync_embeddings.py` 做这件事,要点:

- **共享库全程只读**,没有一条写语句 —— 不需要和队友协调
- 按 **`(source_id, chunk_index)`** 对齐,**不用 `chunk_id`**:那是自增列,两库编号不同,用它会错配
- **文本不一致就跳过并报告**,不会把别人的向量安到内容不同的 chunk 上
- 默认不覆盖本地已有向量(`--overwrite` 可强制),`--dry-run` 先看对齐情况

云端隧道(本地 5432 被 Postgres.app 占、5433 被容器占,所以用 **5434**):

```bash
ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem -N -L 5434:localhost:5432 ubuntu@<IP>
```

### 本地比共享库多 22 条 chunk —— 是改进,不是分歧

```
datadog_alert 12 + invoice 8 + nps_survey 2 = 22
```

这 22 篇文档在 corpus 里 `category` 字段**为空**。共享库那版代码要求
`category == 'artifact'` 严格匹配,把它们判成非 artifact 拒掉了;
`derive_category()` 按 `doc_type` 在白名单里把它们找回来了 —— 告警、发票、NPS 调研
本来就是员工可见的工件。

对齐结果里**文本差异 0 条**,证明两边 chunker 完全一致。这 22 条没有 Titan 向量,
但关键词检索仍能命中。

---

## 4. 运行步骤

```bash
export DATABASE_URL="postgresql://orgforge:orgforge-local@localhost:5433/orgforge"

docker compose up -d database                       # 起库(healthy 约 4s)
npx tsx scripts/migrate.ts                          # migration 001–005
.venv/bin/python scripts/orgforge/ingest.py         # 全量 ingestion(约 1m10s)
.venv/bin/python orgforge_kb/build_graph.py         # 建图(约 1.3s),可加 --reset
```

Embedding 二选一:

```bash
# A. 从共享库同步(当前采用;需先开 5434 隧道并设 SHARED_DATABASE_URL)
.venv/bin/python orgforge_kb/sync_embeddings.py --dry-run   # 先看对齐
.venv/bin/python orgforge_kb/sync_embeddings.py

# B. 自己用 Bedrock 生成(待账号放行)
npx tsx scripts/orgforge/embed.ts --dry-run                 # 成本预检,不调 API
npx tsx scripts/orgforge/embed.ts
```

导出图切片给可视化:

```bash
.venv/bin/python orgforge_kb/export_graph.py --seed EVT-1-sprint_planned-49 --depth 3 --include-actors
.venv/bin/python orgforge_kb/export_graph.py --incidents-only --include-actors -o graph.json
```

`migrate.ts` **每次重跑所有 migration**,所以 migration 必须幂等(005 全部 `IF NOT EXISTS`)。
ingestion、建图、向量同步都是幂等的,可反复重跑。

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
| `orgforge_kb/sync_embeddings.py` | 从共享库拉取 Titan 向量(只读对方) |
| `orgforge_kb/export_graph.py` | 导出图切片为 JSON(可视化 / 交换) |
| `orgforge_kb/query_slice.py` | 选出一个 question 相关的切片(全文 + 图 + 语义三条腿) |
| `orgforge_kb/cognee_memory.py` | 把切片交给 cognee 做涌现抽取 / recall / 导图 |
| `src/adapters/postgres-company-knowledge.ts` | 混合检索 + 证据链补全(artifact-only) |
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

document_chunks 已 embed   7,504 / 7,526   (amazon.titan-embed-text-v2:0)
  未 embed 的 22 条 = 共享库没有的那批(见 §3.5)
向量维度 1024,L2 范数 1.0000  (Titan normalize=true,与 vector_cosine_ops 匹配)
```

**Oracle 安全**:`document_chunks` 里只有 `category='artifact'`,sim_event 一条都没有。
关键词检索实测 top-5 全部是 artifact。`related()` / `sources()` / `relatedThroughEvents()`
三条路径实测 **EVT 泄漏 0 条**;直接点名索取一个 sim_event,`sources()` 返回 0 行。

**语义检索有效性**:以一张 cost-tagging 合规工单为种子,跨类型召回
confluence 设计文档(相似度 0.72 / 0.66)、外部邮件(0.64)、zoom 转写(0.61)、
相关工单(0.60)。此前用离线 hash 向量时距离全在 ~0.9、无区分度。

**2 跳证据补全**:`CONF-ENG-022` 直连 artifact 0 条 → 穿透事件枢纽后得到 `HR-101`
(同一决策产生的工单),事件本身不出现在结果中。

**因果链遍历**(递归 CTE,带深度与环保护),种子 `EVT-1-sprint_planned-49`:
深度 0/1/2 分别命中 1 / 28 / 1 个节点。

**测试**:`npm test` 90 项,86 通过 / 0 失败 / 4 跳过;`npm run typecheck` 无错误。

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

-- 2 跳补全不得泄漏事件:必须为 0
WITH seeds AS (SELECT node_id FROM graph_nodes
               WHERE node_type='document' AND ref_key='CONF-ENG-022'),
causes AS (SELECT DISTINCT e.src_node_id AS node_id FROM graph_edges e
           JOIN seeds ON e.dst_node_id = seeds.node_id WHERE e.edge_type='references'),
siblings AS (SELECT DISTINCT e.dst_node_id AS node_id FROM graph_edges e
             JOIN causes ON e.src_node_id = causes.node_id WHERE e.edge_type='references')
SELECT count(*) FROM siblings s JOIN graph_nodes n ON n.node_id = s.node_id
WHERE n.props->>'category' <> 'artifact';
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

## 7.5 图②:按 query 的涌现记忆(cognee)

图①说明语料**已经记录**了什么(谁引用谁、谁参与了什么);它说不出文本的**含义**——
某个决定被推翻了、两个团队对原因有分歧、风险在出事前就被提过。这些要靠 LLM 读正文抽取。

对全部 4,988 篇做抽取既慢又贵,而且绝大部分与任何单个问题无关。所以**按 query 做**:

```
question
   │
   ├─ query_slice.py  选出这个问题相关的十几篇 artifact
   │     ① 种子:全文检索(先要求全部词项,落空则退化为任一词项)
   │     ② 图扩展:直连引用 + 2 跳穿透事件枢纽
   │     ③ 语义扩展:用种子**已存的向量**找相似文档
   │        ← 不需要给 question 算向量,绕开了 Bedrock 阻塞
   │
   └─ cognee_memory.py  只把这一小片交给 LLM 抽取
         → Ladybug(图)+ LanceDB(向量)+ SQLite(元数据),全是本地文件
```

成本随**问得多少**走,而不是随语料规模走;记忆围绕真实使用累积。
每篇文档带 `why` 字段,标明它是被哪条腿选中的,便于调参与排查。

**存储隔离**:cognee 用自己的嵌入式栈(`orgforge_kb/.cognee/`,已 gitignore),
不部署任何服务。Postgres 里的确定性图仍是权威,**cognee 侧不回写**。

**一个坑**:cognee 1.6 默认开启多用户访问控制,图数据是**按 dataset 作用域**存的。
直接问 `get_graph_engine().get_graph_data()` 会返回 0 个节点(看起来像抽取失败,其实数据都在),
必须经 `get_default_user()` → `get_authorized_existing_datasets()` → `fetch_dataset_graph_data(ds, full=True)`
这条路读。`full=True` 也必要,否则只返回一个有界邻域而非整个 dataset。

实测切片规模(三个问题):12–14 篇 / 约 17k 字符,适合单次 LLM 抽取。
"why did the TiDB migration slip" 在只用全文检索时**完全落空**,
加了 any-term 退化 + 图扩展后,捞出了关键词没命中的 `PROD-102 "Produce TiDB debt reduction roadmap"`。

```bash
.venv/bin/python orgforge_kb/query_slice.py "why did the TiDB migration slip" -o slice.json
.venv/bin/python orgforge_kb/cognee_memory.py remember slice.json
.venv/bin/python orgforge_kb/cognee_memory.py recall "who raised the TiDB risk first?"
.venv/bin/python orgforge_kb/cognee_memory.py graph -o emergent.json   # 与 export_graph.py 同格式,可并排对比
```

**LLM 配置**(任意 OpenAI 兼容端点,经 LiteLLM):

```bash
LLM_PROVIDER=custom
LLM_ENDPOINT=https://soclaas-api.comp.nus.edu.sg/v1
LLM_MODEL=openai/qwen3.8:27b
LLM_API_KEY=...
```

**实测结果(2026-09-26,DeepSeek v4-pro)**:13 篇 / 30,861 字符的切片,抽取耗时 2m24s,
产出 **403 节点 / 1020 边**。`recall` 给出的答案是图①无法给出的因果解释:

> The TiDB migration slipped because the Jenkins migration step was skipped after
> `runMigration` was removed from the Helm default values file. Earlier, the Jenkins
> run also hit a connection timeout to the new RDS due to VPC security group settings.

涌现出的关系类型正是确定性图无法表达的:

```
legacy authentication service  --has_risk-->      service downtime during cut-over
data loss during dual-write    --mitigated_by-->  kafka connect
ios swift login sdk            --blocked_by-->    java 8 auth-service
athlete dashboard              --depends_on-->    titandb
deepa                          --owns-->          terraform-infra
```

边类型分布:`contains` 353、`is_a` 309、`made_from` 13、`is_part_of` 13、
`has_risk` 10、`has_phase` 8、`references` 7、`has_goal` 7。

---

## 7.6 前端可视化(`/graph`)

一个页面,两种看法,同一份数据:

- **图示** —— 内联 SVG,自己写的小型力导向布局(弹簧 + 斥力,320 步跑完再绘制,
  不做入场动画,所以指针下的东西不会移动)。**没有引入任何图库**,与项目"零构建、
  vanilla JS"的现状一致。
- **表格** —— 列出这一视图里的每一条关系。它不是事后补的降级方案:力导向图对不看屏幕的人
  毫无意义,即便看得见也难以精确核对,所以**表格才是关系的可核查来源**。两者由同一个响应渲染。

三种取法:事故相关工件 / 单条因果链(给定起点与步数)/ 某一类工件,可选是否包含人。

**无障碍**(按 `ui-ux-pro-max` 对 network graph 的判定 —— 风险等级 high):

- 节点靠**形状**区分而非仅颜色:圆=工件、方=模拟事件、菱形=人;事故用红色**并**在
  `aria-label` 里写明
- 每个节点 `tabindex="0"`,Tab 可遍历;聚焦即在右栏显示详情(键盘不必按 Enter 也能读到)
- Enter / Space 选中;详情里的邻居是按钮,点击后**把焦点移到那个节点**,键盘不会掉出图外
- `:focus-visible` 用 `--gold` 描边,`prefers-reduced-motion` 下关闭所有过渡

**节点上限**:skill 的阈值是 ≤100 节点用 SVG、101–500 用 Canvas、>500 必须先聚类。
所以服务端 `graphSlice` 把 `limit` 封在 150(不信任调用方传值),前端只画前 120 个,
其余在状态行说明"未绘制,见表格"。

```
GET /api/v1/graph?seed=EVT-1-sprint_planned-49&depth=2&includeActors=true
GET /api/v1/graph?incidentsOnly=true&includeActors=true&limit=40
GET /api/v1/graph?sourceType=jira&category=artifact&limit=30
```

**实测**(真实库,22,606 节点图):

```
因果链 d2 +人   41 节点 / 67 边   悬空边 0
事故 +人        51 节点 / 74 边   悬空边 0  truncated
jira 工件 +人   37 节点 / 30 边   悬空边 0  truncated
未知起点        HTTP 404(而不是画一张空图)
未配置图        HTTP 503
```

渲染检查(jsdom + 真实数据):41 个节点全部绘制、坐标落在 viewBox 内、
**重叠节点对 0**、表格 67 行与边数一致。

切片里**可以**包含模拟事件——因果链正是要看的东西,而且只有标签和类型过网,
**从不传文档正文**(oracle 信息在正文里)。这与检索层只返回 artifact 的约束并不冲突:
两者传的东西不同。

---

## 8. 待办

已完成:全量 ingestion、图①、混合检索、2 跳证据补全、向量落地(经共享库同步)、
图②(cognee 抽取)、以及 `/graph` 前端可视化。

- [ ] **本机 Bedrock 仍未放行** —— 账号级 allowlisting 未批,需提
      `bedrock-allowlisting` support case(hackathon 账号建议直接找主办方)。
      **当前不阻塞**:向量已从共享库同步到位(§3.5)。放行后 `embed.ts` 可直接跑,
      也能补上缺向量的那 22 条。
- [ ] **统一 AWS 认证方式** —— 团队 `.env.example` 用 `AWS_PROFILE=sme-agent` + `aws login`,
      并注明「never put AWS access keys in this file」;而当前手上是 Bedrock bearer token。
      需与队友对齐。团队 region 为 `ap-southeast-2`。
- [ ] **实现检索路由三条路径**(§2)。语义与图两条腿现已齐备。
- [x] **图②(cognee)已跑通** —— DeepSeek v4-pro 抽取,403 节点 / 1020 边,见 §7.5。
- [ ] **抽取放同步还是异步** —— 实测一个 13 篇的切片要 **2m24s**,
      显然不能放在交互式问答的同步路径上。需要改成后台任务:先用 Postgres 检索答复,
      cognee 的抽取结果供后续 query 与可视化使用。
- [ ] **模型选型** —— `v4-pro` 是 thinking 模型(同一句输入比 flash 多花 53 token)。
      抽取任务可试 `openai/deepseek-v4-flash` 降低耗时与成本。
- [ ] **384 维是否够用** —— 当前用 `bge-small-en-v1.5`(384 维,67MB)。
      候选池只有十几篇文档,理论上够;若召回质量不足,换 `bge-base`(768)或
      `bge-large`(1024)重跑即可,切片小所以代价很低。
- [ ] **把切片选择接进检索路由** —— `query_slice.py` 的三条腿(全文 / 图 / 语义)
      正是 §2 路由要的构件,目前是独立 CLI,尚未接入 agent 的工具链。
- [x] **确定性图的前端可视化** —— 见 §7.6。
- [ ] **把涌现图也接进同一页面** —— `cognee_memory.py graph` 的输出已是同构 JSON
      (`{nodes, edges, meta}`),但它存在本地 cognee 文件里,Node 侧读不到;
      需要一条上传/读取导出文件的路径,才能与确定性图并排对比。
- [ ] 补充数据尚未接入:`domain_registry.json`、`simulation_snapshot.json`、
      `assignment_scores.parquet`、`datadog_metrics.parquet`
      (对应 `graph_edges` 里预留的 `owns_domain` / `triggered_by` / `part_of` 边)
