# 修复 Windows 上的源码检出与测试行尾问题

<!-- release-target: v2 -->

## Bug 修复

- 修复 Windows 上使用默认 git 配置检出仓库时，源码被转换为 CRLF 行尾并导致 V2 测试大面积失败的问题。