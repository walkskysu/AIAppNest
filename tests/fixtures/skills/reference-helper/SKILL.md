---
name: reference-helper
description: 阅读包内参考资料并按要求整理摘要。
allowed-tools: read
metadata:
  aiappnest:
    skillId: 763ac5e7-3d46-48c7-9bd8-35469f67e403
    version: 1.0.0
    dependencies:
      - name: node
        constraint: '*'
    capabilities: [read]
    references: [reference.md, scripts/marker.cjs]
---
阅读 [资料](reference.md)，用简洁中文整理摘要。

[辅助脚本](scripts/marker.cjs) 仅用作测试导入期间不执行脚本；导入和校验不得运行它。
