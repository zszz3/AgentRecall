# Skill 名字不再被文件里的嵌套字段顶掉

<!-- release-target: both -->

## Bug 修复

- 修复 Skill 列表可能显示错名字和错简介的问题：SKILL.md 顶部信息里如果有带缩进的嵌套字段，而嵌套里也写了 `name` 或 `description`，之前会把嵌套里的值当成这个 Skill 自己的名字和简介显示出来。
