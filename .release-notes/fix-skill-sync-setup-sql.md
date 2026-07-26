# 修复 Skills 同步初始化 SQL

## Bug 修复
- 修复 Supabase Skills 初始化 SQL 中约束升级语句被插入到 create table 内部的问题；避免用户复制 setup SQL 到 Supabase SQL Editor 后出现语法错误。