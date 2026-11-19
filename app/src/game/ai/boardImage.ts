/**
 * 棋盘 → PNG 图片（dataURL）。BOSS 关把当前局面画成一张带坐标标注的棋盘图，
 * 走多模态接口发给 LLM（deepseek-flash 等视觉模型直接看图落子），
 * 替代原来过长的 ASCII 文字棋盘。
 *
 * 画法与 goban 坐标系一致：列字母 A..（无 I）上/下各一行，行号左/右各一列，
 * 顶行 = height，底行 = 1。最后一手画红点标记，帮模型识别最新局面。
 */

const COL_SEQ = "ABCDEFGHJKLMNOPQRSTUVWXYZ"; // 围棋惯例：没有 I

export function renderBoardImage(
    board: ReadonlyArray<ReadonlyArray<number>>,
    width: number,
    height: number,
    lastMove?: string | null, // "C4" / "pass"，红点标记
): string {
    const cell = 64;
    const pad = 48;
    const size = Math.max(width, height) * cell + pad * 2;

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d 不可用");

    // 居中：小棋盘在正方形画布里留白
    const offX = (size - width * cell) / 2;
    const offY = (size - height * cell) / 2;
    const px = (x: number) => offX + x * cell + cell / 2;
    const py = (y: number) => offY + y * cell + cell / 2;

    // 木底
    ctx.fillStyle = "#dcb35c";
    ctx.fillRect(0, 0, size, size);

    // 网格
    ctx.strokeStyle = "#3c2814";
    ctx.lineWidth = 2;
    for (let x = 0; x < width; x++) {
        ctx.beginPath();
        ctx.moveTo(px(x), offY);
        ctx.lineTo(px(x), offY + (height - 1) * cell);
        ctx.stroke();
    }
    for (let y = 0; y < height; y++) {
        ctx.beginPath();
        ctx.moveTo(offX, py(y));
        ctx.lineTo(offX + (width - 1) * cell, py(y));
        ctx.stroke();
    }

    // 坐标标注：列字母上/下，行号左/右（顶行 = height，底行 = 1）
    ctx.fillStyle = "#3c2814";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let x = 0; x < width; x++) {
        const label = COL_SEQ[x] ?? "?";
        ctx.fillText(label, px(x), offY - pad / 2);
        ctx.fillText(label, px(x), offY + (height - 1) * cell + pad / 2);
    }
    for (let y = 0; y < height; y++) {
        const rowNum = height - y;
        ctx.fillText(String(rowNum), offX - pad / 2, py(y));
        ctx.fillText(String(rowNum), offX + (width - 1) * cell + pad / 2, py(y));
    }

    // 棋子
    const r = cell * 0.44;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const v = board[y][x];
            if (v === 0) continue;
            ctx.beginPath();
            ctx.arc(px(x), py(y), r, 0, Math.PI * 2);
            ctx.fillStyle = v === 1 ? "#1a1a1a" : "#fafafa";
            ctx.fill();
            ctx.lineWidth = v === 2 ? 2 : 1;
            ctx.strokeStyle = "#000";
            ctx.stroke();
        }
    }

    // 最后一手红点
    if (lastMove && lastMove !== "pass") {
        const ch = lastMove[0]?.toUpperCase() ?? "";
        const x = COL_SEQ.indexOf(ch);
        const row = Number.parseInt(lastMove.slice(1), 10);
        if (x >= 0 && x < width && !Number.isNaN(row)) {
            const y = height - row;
            if (y >= 0 && y < height) {
                ctx.beginPath();
                ctx.arc(px(x), py(y), r * 0.28, 0, Math.PI * 2);
                ctx.fillStyle = "#e0392e";
                ctx.fill();
            }
        }
    }

    return canvas.toDataURL("image/png");
}
