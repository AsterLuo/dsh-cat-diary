# dsh-cat-diary

> 猫娘日记 + 好感度，为 DeepSeek Harness 做的插件。

每天把当天**全部**对话写成一篇四栏日记，第二天新开对话时自动注入「昨日速读卡」；
好感度作为子插件每轮自动判定，侧边栏可看走势、加减原因和最近 7 天日记。

## 它做什么

| 模块 | 职责 |
| --- | --- |
| **日记主体** | 采集会话 → 模型写前三节 → **代码生成第四节** → 写入 `<DSH_HOME>/storages/dsh-cat-diary/<人格>/days/` |
| **好感度子插件** | 每轮判定一次、事件账本、日额度、只读路由 |
| **侧边栏面板** | 分数、状态、走势、加减原因、最近 7 天日记（**只读**） |

### 四个设计约束

1. **好感度账本是唯一写入方**。日记、速读卡、长期记忆、UI 全是读者，「日记说 74、账本说 70」这种分歧在结构上不可能发生。
2. **每轮必判，但不代表每轮必变**。判定由宿主在 `agent/pre-step` 首步发起，不是靠提示词求模型调工具——实测提示词写得再清楚，模型也会挑更短的路直接 finish。
3. **失败必须落盘**。判定失败写 `failed` 记录，绝不伪装成「不变」；否则「跑了但失败」和「根本没跑」在外部看起来一模一样。
4. **日记第四节永远是代码产物**。模型只写知识、感想、印象三节。

## 安装

### 方式一：从 GitHub 直接装（推荐）

```bash
dsh plugin --profile <你的profile> add github:AsterLuo/dsh-cat-diary
```

指定版本：

```bash
dsh plugin --profile <你的profile> add github:AsterLuo/dsh-cat-diary#v1.0.0
```

### 方式二：下载 release 里的 zip

在 [Releases](https://github.com/AsterLuo/dsh-cat-diary/releases) 下载 `dsh-cat-diary-v1.0.0.zip`，
解压到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-cat-diary/`，
然后在 profile 的 `package.json` 里加上依赖并写入 `dsh.profile.bundles`。

> 好感度子插件随主包一起装，不需要单独安装。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖配置（**只覆盖，不要重复 insert**）：

```yaml
- id: cat-diary
  disabled: false
  config:
    cutoffHour: 5              # 换日小时，凌晨 5 点前的对话算前一天
    briefBytes: 6000           # 速读卡字节上限
    autoWrite: true            # 每次启动补写欠下的日记
    autoWriteDelayMs: 8000     # 启动后延迟多久再跑（等服务和模型就绪）
    autoWriteMaxDays: 7        # 最多往回追几天
    autoWriteMaxTokens: 3200   # 生成输出上限
    autoWriteRawChars: 24000   # 喂给模型的原料字符上限

- id: affinity
  disabled: false
  config:
    maxStep: 2                 # 单次最大变化量
    maxDaily: 10               # 每日绝对值累计上限
    stepJudge: true            # 每轮自动判定
    person: default            # 人格 id，数据目录名
```

### 人格 id

默认是 `default`，数据落在 `<DSH_HOME>/storages/dsh-cat-diary/default/`。
想用别的名字就改 `person`；也可以只设环境变量：

```bash
DSH_CAT_DIARY_PERSONA=alice    # 日记
DSH_AFFINITY_PERSONA=alice     # 好感度
```

两者要一致，否则日记和好感度会读写不同的目录。

## 为什么是「开机补写」而不是定时任务

日记日按 05:00 换日，意味着日记该在 05:00 之后生成——而那个点电脑通常是关着的，定时器根本不会响。
所以改成**每次启动时补作业**：抓住「一天已经结束、但日记还没写」这个状态，写一次就够。

补写是幂等的：判断依据是磁盘上有没有 `days/<day>.md`，不是内存状态，所以重启多少次都只写一次。
已存在的日记**一律不碰**——你可能手动改过。

## 命令行

```bash
node bin/diary.mjs open [--date yesterday]      # 昨日速读卡
node bin/diary.mjs show [--date D]              # 整篇日记
node bin/diary.mjs list                         # 列出日记
node bin/diary.mjs collect --date D             # 只采集原料
node bin/diary.mjs raw --date D                 # 看原料
node bin/diary.mjs write --date D --file F      # 写入（四栏校验）
node bin/diary.mjs affinity show                # 好感度账本（只读）
node bin/diary.mjs knowledge [关键词]           # 检索知识
node bin/diary.mjs backfill --days 7 --dry-run  # 补历史 + 成本预估
node bin/diary.mjs status                       # 报数
```

## 好感度状态

每 20 分一档，共 10 档：

| 分数 | 状态 |
| --- | --- |
| 80 ~ 100 | 心之所向 |
| 60 ~ 79 | 暖光常驻 |
| 40 ~ 59 | 檐下初逢 |
| 20 ~ 39 | 渐生默契 |
| 10 ~ 19 | 偶然相望 |
| -9 ~ 9 | 不相熟 |
| -29 ~ -10 | 隔了层雾 |
| -49 ~ -30 | 话少了 |
| -69 ~ -50 | 避着走 |
| -100 ~ -70 | 关上了门 |

## 测试

```bash
npm test
```

128 项测试。另外有个隔离验证脚本：

```bash
node scripts/prove-isolation.mjs
```

它会比对真实 `<DSH_HOME>/sessions` 在测试前后的文件集合变化 ——
**测试绿不等于没有副作用**，一次环境变量拼错曾让 56 条假会话写进真实用户数据。

## 数据在哪

```
<DSH_HOME>/storages/dsh-cat-diary/<人格>/
  days/2026-11-01.md           # 日记正文
  days/2026-11-01.meta.json    # 元信息
  raw/2026-11-01.md            # 采集的原料
<DSH_HOME>/storages/dsh-affinity/<人格>/
  affinity/events.jsonl        # 好感度事件账本（权威）
  affinity/state.json          # 派生缓存，手改无效
```

删插件不影响这些数据。

## License

MIT
