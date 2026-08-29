# Workflow 运行 Inspector 可以正常关闭了
<!-- release-target: v2 -->

## Bug 修复

- 修复 Workflow 运行模式下关闭节点 Inspector 后会立即自动弹回、运行结束但有失败节点时完全关不掉的问题；现在进入运行详情仍会自动展开活跃节点，但关闭后保持关闭，直到切换到新的运行才会再次自动展开。
