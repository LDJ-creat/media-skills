## Plan: CSDN 发布与运营 Skill

基于 Playwright + storageState 登录态复用，为 CSDN 创作中心实现“Markdown 文章发布”和“作品数据抓取”两条能力线。推荐复用 get-wechat-data 的跨平台运行时、认证文件发现、raw/normalized 输出和 references 组织方式；同时利用 CSDN 原生支持 Markdown 的特性，避免额外内容转换。首版聚焦手动执行、单篇发布、作品数据抓取，不做自动登录、定时任务或账号运营自动化。

**Steps**

1. Phase 1 - 范围定义与触发语句：将 skill 触发条件限定为“发布 CSDN 文章”“抓取 CSDN 创作中心作品数据”“校验 CSDN 创作中心登录态”。输入为 Markdown 文件与可选 frontmatter 元数据、以及用户提供的 storageState.json 或 cookies.json。输出为发布结果摘要和 JSON/Markdown 数据报告。排除自动注册、验证码处理、批量搬运、多账号切换。
2. Phase 2 - Skill 骨架与命名：新增独立 skill 目录，建议命名为 csdn-publish-and-data 或 csdn-creator。结构保持为 SKILL.md、scripts/、references/。脚本目录建议包含 common.ts、types.ts、check-environment.ts、check-login.ts、fetch-analytics.ts、post-article.ts、export-storage-state.ts、csdn-scraper.ts、normalize.ts。references 至少包含 first-time-setup、export-storage-state、article-posting、output-format、troubleshooting、ubuntu-headless。
3. Phase 3 - 认证与配置设计：优先使用 storageState.json，因为 CSDN 创作中心通常依赖更完整的站点态。认证文件发现顺序沿用 get-wechat-data：CLI -> 项目级 .baoyu-skills/csdn-creator/ -> XDG -> 用户目录。EXTEND.md 建议支持 default_output_dir、default_post_mode、default_categories、default_tags、default_original_flag、default_save_raw、default_timeout_ms、cookie_file_name、storage_state_file_name。明确 Linux 服务器场景采用“本地导出 storageState，服务器复用”的路径。
4. Phase 4 - 发布链路设计：发布脚本读取 Markdown 与 frontmatter，打开 CSDN 编辑器页面 https://mp.csdn.net/mp_blog/creation/editor?not_checkout=1&spm=1011.2415.3001.6192，自动填写标题、正文、分类、标签、原创/转载声明、摘要等必要字段，再执行保存草稿或发布。优先采用编辑器 DOM 自动化，因为正文是 Markdown 原生支持；必要时监听草稿保存/发布请求，捕获文章 ID、文章链接、状态与错误消息。首版建议先稳定“保存草稿 + 发布成功检测”，后续再扩展封面、专栏等附加元数据。
5. Phase 5 - 作品数据抓取设计：主要抓取作品数据页 https://mp.csdn.net/mp_blog/analysis/article/all?spm=1011.2415.3001.10339，并结合内容管理页 https://mp.csdn.net/mp_blog/manage/article?spm=1011.2415.3001.10336 做状态补充。执行顺序为：校验登录态 -> 打开作品数据页和内容管理页 -> 监听 XHR/fetch 响应与必要 DOM 状态 -> 识别作品概览、单篇明细、文章状态列表 -> 保存 raw 记录并归一化。若管理页没有稳定接口，再将文章列表表格作为回退数据源。
6. Phase 6 - normalized 数据模型：作品数据建议提炼 totalViewCount、totalDiggCount、totalCommentCount、totalCollectCount、articleRows、dailyTrendRows；文章管理数据建议提炼 articleId、title、status、publishTime、lastModifiedAt、articleUrl。normalized 输出按 overview、articles、dailyTotals 三层组织；records 保留原始页面与网络响应；metrics 仅作为兼容摘要，不再扁平化所有数字字段。
7. Phase 7 - CLI 设计：post-article.ts 支持 --file、--title、--tags、--category、--original、--draft、--publish、--state、--cookie、--headful、--timeout。fetch-analytics.ts 支持 --page analytics|manage|both、--start、--end、--output、--save-raw、--state、--cookie。check-login.ts 校验是否能进入 mp.csdn.net 创作中心而不是登录引导页。必要时加入 --probe 仅验证登录和响应捕获。
8. Phase 8 - references 与文档设计：SKILL.md 仅保留技能触发、脚本目录、认证发现顺序、推荐命令、输出产物位置、边界说明。其余细节下沉到 references，尤其是 CSDN 编辑器必填字段、storageState 导出步骤、Ubuntu 依赖、常见失败场景和 output-format。文档要明确“无需做 Markdown 转 HTML 转换”，这就是与公众号 skill 的关键差异之一。
9. Phase 9 - 验证策略：先在本地有界面环境验证 storageState 导出、登录有效、草稿保存和发布成功提示；再抓取作品数据页和内容管理页，确认 raw 响应存在、normalized 字段稳定、Markdown 报告可读。最后在 Ubuntu 无 GUI 环境复用 storageState 验证 headless 运行、输出目录、错误码与日志提示。
10. Phase 10 - 边界与后续扩展：首版不做批量迁移、草稿批处理、评论互动、粉丝数据、活动数据、收益数据，也不做自动重试与截图归档。为后续保留扩展位：粉丝数据抓取、专栏绑定、自动封面、内容更新而非新建、失败回滚策略。

**Relevant files**

- get-wechat-data/SKILL.md — 复用 storageState 优先、手动执行流程、输出目录和 normalized 说明
- get-wechat-data/scripts/common.ts — 复用认证发现、路径解析、CLI 参数模式
- get-wechat-data/scripts/types.ts — 参考如何定义 raw capture、normalized summary、daily rows 等类型层次
- get-wechat-data/references/config/first-time-setup.md — 复用跨平台与 headless 前置说明
- baoyu-post-to-wechat/SKILL.md — 参考发布类 skill 的工作流组织和文章输入处理逻辑

**Verification**

1. 运行 check-environment 与 check-login，确认 CSDN 创作中心可在 storageState 下直接访问，无登录跳转。
2. 用示例 Markdown 运行 post-article.ts 的草稿模式，确认标题、正文、分类和标签正确落地，并得到草稿或文章链接。
3. 运行 fetch-analytics.ts 抓取 analytics 与 manage 两类页面，确认 raw 目录落盘，normalized 含 overview、articles、dailyTotals 等核心字段。
4. 在 Ubuntu 无 GUI 环境复用 storageState 再跑一次 check-login 和 fetch-analytics，确认 headless 行为一致。
5. 演练登录态失效、管理页接口变化、编辑器必填项缺失三类异常，确认脚本能返回清晰错误和非零退出码。

**Decisions**

- 推荐单 skill 覆盖“发布 + 作品数据抓取”，但脚本实现保持分层解耦。
- 认证方案以 storageState.json 为主，cookies.json 为回退。
- Markdown 直接交给 CSDN 编辑器处理，不引入额外正文转换器。
- 数据输出沿用 records + normalized + curated metrics 三层；Markdown 报告直接读 normalized。
- 首版只抓作品数据与内容管理，不扩展粉丝、收益等更多运营模块。

**Further Considerations**

1. 发布模式默认值：建议首版默认保存草稿，显式 --publish 才发布，降低误发风险。
2. 文章标识关联：建议尽早确定是以 articleId 还是 URL 作为主键，用于把管理页和数据页做关联。
3. 必填字段收敛：建议在实施前先确认 CSDN 编辑器的最小必填集，避免脚本后续频繁补字段。
