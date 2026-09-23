# 示例 11：屏幕上的苍蝇 — Hill Climbing 自学习
    
    把项目落地到桌面！一只**自学习的苍蝇**在浏览器窗口里飞来飞去，你的**鼠标就是"手"**，越靠近它就越会飞走。
    
    ## 启动
    
    ```bash
    # 1. 启动 HTTP 服务（端口 4311）
    # 2. 浏览器访问 http://127.0.0.1:4311/
    ```
    
    一键启动脚本见下方的"自动启动"小节。
    
    ## 玩法
    
    1. **移动鼠标** 进画面里 — 鼠标位置就是"手"
    2. **追苍蝇** — 看它怎么逃
    3. **观察学习曲线** — 右上角"历史分数"面板会画出历代得分
    4. **训练几分钟后** — 苍蝇会越学越精，越来越难抓
    
    ## 蝇脑架构（沿用项目 12-DN 神经元命名）
    
    ```
    输入 (12 特征)                输出 → 决策
    ─────────────────              ────────────
    TARGET_DN L/R    鼠标水平位置     z = W·X + b
    LOOM_DN L/R      鼠标水平逼近     panic = σ(z)
    ESCAPE_DN L/R    横向安全距离     if panic ≥ 阈值:
    DNae002 L/R      鼠标垂直位置         朝远离鼠标方向喷射
    DNg111 L/R       鼠标垂直速度     else:
    DNp01 L/R        苍蝇自身速度         随机游荡
    ```
    
    **单 sigmoid 输出 → 标量"恐慌度"**（0=镇定，1=极度恐慌）
    - 触发逃跑后，方向是**硬编码**的「远离鼠标」（仿生：苍蝇的逃跑方向是反射性的）
    - 但**何时触发** 是脑学会的（阈值附近 + 12 权重）
    
    ## 自学习算法：1+1-ES Hill Climbing
    
    跟 `examples/10-trial-and-error.ts` **完全相同**的逻辑：
    
    ```js
    1. champion = 当前最佳脑
    2. challenger = champion + 高斯噪声扰动
    3. 跑一代 (5 秒) 评估 challenger
    4. if challenger 得分 > 上一代冠军分:
          champion = challenger    // 接受：保留"经验"
          generation++
       else:
          保持 champion 不变        // 拒绝：没进步就回退
    5. σ = 0.5 × 0.96^generation  (越学越精细)
    6. 回到 2
    ```
    
    **零依赖**：纯浏览器实现，**没加载** 任何预训练脑，`freshModel()` 随机起步。
    
    ## 奖励函数
    
    ```js
    if dist < HIT_RADIUS:
        reward = -10     // 命中：大罚 + 物理击退
    else:
        reward = dist / 1400   // 距离奖励（连续 0~1）
    ```
    
    - **稀疏 -10**：抓到了才有，让脑学会"什么时候该跑"
    - **连续距离奖励**：让脑"想跑得越远越好"
    
    ## 控制面板
    
    | 控件 | 作用 |
    |---|---|
    | 重置脑 | 重新随机初始化（清空历史） |
    | 保存脑 | 导出 JSON（权重+偏置+阈值+历史） |
    | 加载脑 | 从文件载入（接着上次的进度） |
    | 代长 | 1 代多少秒（1~60，默认 5） |
    | σ 初值 | 扰动强度（0.05~2，默认 0.5） |
    
    ## 文件清单
    
    ```
    examples/11-screen-fly/
    ├── index.html    ← 一切都在这里（HTML+CSS+JS）
    └── README.md     ← 本文件
    ```
    
    无服务器后端，无构建步骤，单 HTML 离线可跑。
    
    ## 跟项目的关联
    
    | 项目现有 | 这个示例用到 |
    |---|---|
    | `src/readout.ts` 的 `inferReadout()` sigmoid 公式 | **完全相同**（单输出感知机） |
    | `examples/10-trial-and-error.ts` 的 1+1-ES 逻辑 | **完全相同**（champion/challenger 模式） |
    | 12 个 DN 神经元命名 | **沿用**（语义重映射到"鼠标 vs 苍蝇"） |
    | `freshModel()` 随机初始化 | **沿用** |
    
    差别只在 **state 形状**：
    - 项目：`{birdY, pipeX, gapCenterY, ...}`
    - 本示例：`{fly.x, fly.y, mouse.x, mouse.y, dist, closingSpeed, ...}`
    
    ## 自动启动
    
    ```bash
    # 用 web 插件：
    ext_call web web_start {port: 4311}
    ext_call web web_register_static {urlPath: "/", folder: "examples/11-screen-fly"}
    # 然后浏览器开 http://127.0.0.1:4311/
    ```
    
    ## 调参建议
    
    | 现象 | 调什么 |
    |---|---|
    | 苍蝇学得太慢/没进步 | **加大** σ 初值（0.8~1.2） |
    | 苍蝇越学越差 | **减小** σ 初值（0.1~0.3） |
    | 苍蝇不动/站着等死 | **减小** HIT_RADIUS 或加大惩罚 |
    | 想快速迭代 | **减小** 代长到 1~2 秒 |
    | 想看长期趋势 | **加大** 代长到 20~60 秒 |
    
    ## 已知局限 / 可能的扩展
    
    - 只有 1 个 sigmoid 输出 → 方向硬编码（仿生但可玩性受限）
    - 想让苍蝇学会**自由 8 方向逃跑**：把输出扩成 8 个 sigmoid，每个方向一个权重集
    - 想让苍蝇**互相学**（进化算法）：把 champion/challenger 扩成种群，参考 `examples/06-evolve.ts`
    - 想接入**真实蝇脑连接组**（lc4/lplc2/lc10...）：用 `src/createTrainer.ts` + `fixtures/brain.json`
    