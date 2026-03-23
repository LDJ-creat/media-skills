---
description: 抓取 微信/CSDN/掘金 的运营数据并进行汇总分析
---

本工作流用于定期获取各平台的阅读量、收藏量、粉丝增长等核心指标，并生成分析报告。

### 第一步：抓取微信公众号数据
使用 @[get-wechat-data](file:///c:/Users/FLDJ/Desktop/skills/get-wechat-data) 获取微信平台的最新运营数据。
1. 确保已更新微信的 `cookie.json`。
2. 运行抓取脚本获取每日统计。

### 第二步：抓取 CSDN 与掘金数据
分别调用以下 Skill 的分析/数据获取脚本：
1. **CSDN**：使用 @[csdn-publish-and-data](file:///c:/Users/FLDJ/Desktop/skills/csdn-publish-and-data)。
2. **掘金**：使用 @[juejin-publish-and-data](file:///c:/Users/FLDJ/Desktop/skills/juejin-publish-and-data)。

### 第三步：多平台数据聚合 (Data Aggregation)
将各平台产出的 JSON 或 Markdown 数据进行汇总。
1. 分析各平台表现最好的文章。
2. 统计过去一周/一月的关注者增长。
3. 对比不同平台的内容受众偏好。

### 第四步：生成运营报告 (Report Generation)
基于聚合后的数据，生成一份 Markdown 格式的运营周报/月报，并存放在 `output/analysis/` 目录下。
1. 包含关键指标图表（Markdown 表格或 Mermaid 图表）。
2. 提供下一步运营建议（如：哪个平台适合发哪类内容）。
