---
description: 选题、写作、配图并发布到 微信/CSDN/掘金
---

本工作流将串联多个 Skill，实现从发现热点到多平台发布的自动化运营闭合回路。

### 第一步：选题与热点筛选 (News Research)
使用 @[news-skill](file:///c:/Users/FLDJ/Desktop/skills/news-skill) 获取最新资讯并筛选有价值的选题。
1. 运行 `news-skill` 的抓取脚本。
2. 筛选出 1-3 个候选选题。
3. 请用户确认最终要创作的主题。

### 第二步：文章撰写 (Article Writing)
针对选定的主题，调用 @[article-writer](file:///c:/Users/FLDJ/Desktop/skills/article-writer) 进行内容创作。
1. 确定文章的目标平台（WeChat/CSDN/Juejin），这会影响写作风格。
2. 产出的 Markdown 文件应存放在 @[output](file:///c:/Users/FLDJ/Desktop/skills/output) 目录下。
3. 确保文章包含完整的 Frontmatter（标题、摘要、标签等）。

### 第三步：配图设计与生成 (Illustration)
针对文章内容，调用 @[article-illustrator](file:///c:/Users/FLDJ/Desktop/skills/article-illustrator) 生成配图。
1. 生成文章封面图。
2. 根据需要生成文章内部插图。
3. 配图产物应统一存放在 @[output](file:///c:/Users/FLDJ/Desktop/skills/output) 或对应的文章子目录下。

### 第四步：多平台发布 (Multi-platform Publishing)
从 @[output](file:///c:/Users/FLDJ/Desktop/skills/output) 中读取最终稿件和图片，发布到对应的平台草稿箱。
1. **微信公众号**：调用 @[baoyu-post-to-wechat](file:///c:/Users/FLDJ/Desktop/skills/baoyu-post-to-wechat) 的预览/发布脚本。
2. **CSDN**：调用 @[csdn-publish-and-data](file:///c:/Users/FLDJ/Desktop/skills/csdn-publish-and-data) 进行草稿保存。
3. **掘金**：调用 @[juejin-publish-and-data](file:///c:/Users/FLDJ/Desktop/skills/juejin-publish-and-data) 进行存草稿操作。

### 第五步：归档
将已发布的文章移动到归档目录，保持 `output` 文件夹整洁。
