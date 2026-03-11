## Plan: 掘金发布与运营 Skill

基于 Playwright + storageState 登录态复用，为掘金平台分别实现“Markdown 文章发布”和“创作者数据抓取”两条能力线。推荐沿用 get-wechat-data 的 raw/normalized 双层输出和 check-login/fetch/post 脚本分层，但发布链路与数据链路解耦，避免编辑器自动化与数据抓取互相影响。首版只做手动执行，不做定时任务、验证码绕过或账号登录。

**Steps**

1. Phase 1 - 作用域与技能触发定义：将 skill 触发范围限定为“发布掘金文章”“获取掘金内容数据/粉丝数据”“检查掘金创作者登录态”。输入为 Markdown 文件、可选封面/标签/分类元数据、以及用户提供的 storageState.json 或 cookies.json。输出为发布结果摘要、JSON/Markdown 数据报告、可选 raw 网络数据。排除自动登录、短信/二维码处理、定时发布编排、多账号管理。
2. Phase 2 - Skill 骨架与命名：新增独立 skill 目录，建议命名为 juejin-publish-and-data 或拆成更短的 juejin-creator。目录结构保持为 SKILL.md、scripts/、references/。SKILL.md 只写工作流和调用条件；复杂说明拆到 references。脚本目录建议至少包含 common.ts、types.ts、check-environment.ts、check-login.ts、fetch-analytics.ts、post-article.ts、export-storage-state.ts、juejin-scraper.ts、normalize.ts。
3. Phase 3 - 认证与配置设计：优先使用 Playwright storageState.json，兼容 cookies.json 回退。认证文件发现顺序沿用 get-wechat-data 方案：CLI 参数优先，其次项目级 .baoyu-skills/juejin-creator/，再到 XDG 或用户级目录。EXTEND.md 建议支持 default_output_dir、default_post_mode、default_tags、default_column、default_visibility、default_save_raw、default_timeout_ms、cookie_file_name、storage_state_file_name。明确说明推荐通过本地有界面浏览器导出 storageState，再在 Ubuntu 无 GUI 服务器直接复用。
4. Phase 4 - 发布链路设计：发布脚本读取 Markdown 正文和 frontmatter，优先直接向编辑器页面填充内容并提交，而不是先做复杂格式转换。实现顺序建议为：解析 Markdown 与元数据 -> 启动带登录态的 Playwright context -> 打开 https://juejin.cn/editor/drafts/new?v=2 -> 定位标题、正文、标签、专栏、封面、可见性等必要控件 -> 执行保存草稿或发布 -> 捕获成功提示、稿件 URL、文章 ID。若 DOM 不稳定，再补抓编辑器相关网络请求，优先复用请求接口而非脆弱选择器。
5. Phase 5 - 掘金数据抓取设计：抓取两个页面，分别是单篇/内容数据中心和粉丝数据页。执行顺序为：校验登录态 -> 打开内容数据页 https://juejin.cn/creator/data/content/article/single 和粉丝数据页 https://juejin.cn/creator/data/follower/data -> 监听 XHR/fetch 响应 -> 按 URL 关键词与 payload 形状筛选有效响应 -> 保留 deduped raw records -> 归一化为业务字段。若网络响应难以稳定识别，再回退页面内嵌状态或表格 DOM。
6. Phase 6 - 数据模型与 normalized 设计：内容数据建议至少提炼 articleId、title、publishTime、viewCount、diggCount、commentCount、collectCount、shareCount、trendRows；粉丝数据建议提炼 totalFollowers、netFollowers、newFollowers、lostFollowers、dateRows，以及平台实际可见的分布数据字段。输出结构保持 records + normalized + curated metrics 三层；其中 normalized 是主输出，metrics 仅作兼容摘要。
7. Phase 7 - CLI 与发布模式设计：post-article.ts 应支持 --file、--title、--cover、--tags、--column、--publish、--draft、--state、--cookie、--headful、--timeout。fetch-analytics.ts 应支持 --page content|follower|both、--start、--end、--output、--save-raw、--state、--cookie。check-login.ts 仅做“能否进入 creator 页面且未跳登录”的明确校验。必要时增加 --probe 模式，便于只验证登录与响应捕获。
8. Phase 8 - references 设计：至少拆出 references/config/first-time-setup.md、references/cookie/export-storage-state.md、references/output-format.md、references/article-posting.md、references/troubleshooting/common-issues.md、references/ubuntu/headless-setup.md。SKILL.md 中只链接这些文件，不重复展开细节，符合 skill-creator 的 progressive disclosure 要求。
9. Phase 9 - 验证策略：先在 Windows/macOS 有界面环境验证登录导出、草稿保存、内容数据与粉丝数据抓取；再在 Ubuntu 无 GUI 环境复用同一份 storageState 跑 check-login 和 fetch-analytics，确认 headless 行为一致。发布功能至少验证保存草稿成功、再次进入可见草稿；数据功能至少验证 raw 响应存在、normalized 字段有值、Markdown 报告可读。
10. Phase 10 - 范围边界与后续增强：首版不做批量发布、多草稿管理、评论回复、私信处理、自动封面生成、分时发布和验证码恢复。为后续保留扩展位：批量导入、定时发布、更多创作者页抓取、失败重试与截图留痕。

**Relevant files**

- get-wechat-data/SKILL.md — 复用 storageState 优先、output/normalized 说明、check-login/fetch 工作流写法
- get-wechat-data/scripts/common.ts — 复用 CLI 参数、认证文件发现、输出目录解析模式
- get-wechat-data/scripts/normalize.ts — 复用 raw 去重与 normalized 产物分层思路
- get-wechat-data/references/output-format.md — 参考如何把 records、normalized、metrics 的边界写清楚
- baoyu-post-to-wechat/SKILL.md — 参考发布类 skill 的触发描述、前置检查和文章处理 workflow

**Verification**

1. 本地运行 check-environment 与 check-login，确认掘金 creator 页面可在 storageState 下正常访问，且不会被重定向到登录页。
2. 使用一篇带 frontmatter 的 Markdown 执行 post-article.ts 的草稿模式，确认标题、正文、标签等字段落到正确位置，并返回草稿或文章链接。
3. 运行 fetch-analytics.ts 抓取 content 与 follower 两类数据，确认 raw 目录存在，normalized 输出包含内容指标和粉丝指标，且日期字段统一。
4. 在 Ubuntu 无 GUI 环境使用同一份 storageState 重跑 check-login 与 fetch-analytics，确认 headless 模式稳定。
5. 分别演练三类异常：登录态失效、编辑器 DOM 变化、数据接口字段变化，确认脚本能给出明确错误而不是静默失败。

**Decisions**

- 推荐单 skill 内含两条能力线：发布与数据，但脚本层保持解耦。
- 认证方案以 storageState.json 为主，cookies.json 仅作兼容回退。
- Markdown 不做额外 HTML 转换，直接填充编辑器；如平台要求额外字段，只补元数据映射，不改正文转换链路。
- 数据抓取沿用 raw/normalized 双层模式，normalized 为主要消费面。
- 首版只支持手动执行，不做调度、账号池和自动登录。

**Further Considerations**

1. 发布目标默认值：建议首版默认保存草稿而不是直接发布，只有显式 --publish 才执行发布。
2. 编辑器策略：建议优先 DOM 自动化，必要时补抓接口，不要一开始就强耦合私有接口。
3. 元数据约束：建议尽早确定 frontmatter 支持字段集合，避免后面反复改命令与文档。
