# Feishu `emoji_type` — 官方完整列表

来源：https://open.larkoffice.com/document/server-docs/im-v1/message-reaction/emojis-introduce

> **关键点**：API **大小写敏感**。`OnIt` 可用；`ONIT` / `ONit` 会报 `code: 231001` "invalid emoji"。
> 先从本列表里挑，别自己拼名字。

## 语义推荐（本插件内的默认值）

| 用途 | 选中 | 备选 |
|---|---|---|
| 收到消息开始处理（doing） | `OnIt` | `Typing`、`OneSecond`、`OK` |
| 完成（done） | `Done` | `CheckMark`、`DONE`、`Yes`、`LGTM` |
| thread 已封存（closed） | `CrossMark` | `No`、`ThumbsDown`、`SKULL` |
| Permission 通过 | `THUMBSUP` | `Yes`、`OK`、`LGTM` |
| Permission 拒绝 | `ThumbsDown` | `No`、`CrossMark` |
| 错误（error） | `ERROR` | `SKULL`、`CrossMark` |
| 关注/喜欢 | `HEART` | `FINGERHEART`、`LOVE` |

## 完整枚举

### 基础反馈
OK · THUMBSUP · THANKS · MUSCLE · FINGERHEART · APPLAUSE · FISTBUMP · JIAYI · DONE

### 表情（正面）
SMILE · BLUSH · LAUGH · SMIRK · LOL · FACEPALM · LOVE · WINK · PROUD · WITTY · SMART · SCOWL · THINKING

### 表情（负面）
SOB · CRY · ERROR · NOSEPICK · HAUGHTY · SLAP · SPITBLOOD · TOASTED · GLANCE · DULL

### 表情（中性 / 其他）
INNOCENTSMILE · JOYFUL · WOW · TRICK · YEAH · ENOUGH · TEARS · EMBARRASSED · KISS · SMOOCH · DROOL · OBSESSED · MONEY · TEASE · SHOWOFF · COMFORT · CLAP · PRAISE · STRIVE · XBLUSH · SILENT · WAVE · WHAT · FROWN · SHY · DIZZY · LOOKDOWN · CHUCKLE · WAIL · CRAZY · WHIMPER · HUG · BLUBBER · WRONGED · HUSKY · SHHH · SMUG · ANGRY · HAMMER · SHOCKED · TERROR · PETRIFIED · SKULL · SWEAT · SPEECHLESS · SLEEP · DROWSY · YAWN · SICK · PUKE · BETRAYED · HEADSET

### 状态 / 工作相关（**注意大小写**）
EatingFood · MeMeMe · Sigh · Typing · Lemon · Get · LGTM · OnIt · OneSecond · VRHeadset · YouAreTheBest · SALUTE · SHAKE · HIGHFIVE · UPPERLEFT

### 手势 / 符号
ThumbsDown · SLIGHT · TONGUE · EYESCLOSED · RoarForYou

### 动物 / 物品
CALF · BEAR · BULL · RAINBOWPUKE · ROSE · HEART · PARTY · LIPS · BEER · CAKE · GIFT · CUCUMBER · Drumstick · Pepper · CANDIEDHAWS · BubbleTea · Coffee

### 判断 / 投票
Yes · No · OKR · CheckMark · CrossMark · MinusOne · Hundred · AWESOMEN

### 通知
Pin · Alarm · Loudspeaker · Trophy · Fire · BOMB · Music

### 节日
XmasTree · Snowman · XmasHat · FIREWORKS · 2022 · REDPACKET · FORTUNE · LUCK · FIRECRACKER · StickyRiceBalls · HEARTBROKEN · POOP

### 状态消息（飞书状态栏系列）
StatusFlashOfInspiration · 18X · CLEAVER · Soccer · Basketball · GeneralDoNotDisturb · Status_PrivateMessage · GeneralInMeetingBusy · StatusReading · StatusInFlight · GeneralBusinessTrip · GeneralWorkFromHome · StatusEnjoyLife · GeneralTravellingCar · StatusBus · GeneralSun · GeneralMoonRest · MoonRabbit · Mooncake · JubilantRabbit · TV · Movie · Pumpkin

### 近期新增
BeamingFace · Delighted · ColdSweat · FullMoonFace · Partying · GoGoGo · ThanksFace · SaluteFace · Shrug · ClownFace · HappyDragon

## 配置 overrides

在 `~/.config/systemd/user/claude-feishu.service` 的 `[Service]` 段加：

```
Environment=FEISHU_REACT_DOING=OnIt
Environment=FEISHU_REACT_CLOSED=CrossMark
```

空串 `""` = 禁用该状态的表情。修完 `systemctl --user daemon-reload && systemctl --user restart claude-feishu`。

Permission 通过 / 拒绝的表情目前在 `src/daemon.ts` 里写死（`THUMBSUP` / `ThumbsDown`），要改直接改那两行。
