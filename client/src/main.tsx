/* 山脊工作台：保留原始地图优先工作流；界面视觉由 TrailCraft 设计令牌统一控制。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import TrailCraftApp from "./trailcraft/App";
import "./trailcraft/index.css";
import "./trailcraft/manus-polish.css";
import "./trailcraft/manus-preview.css";
import { applyTheme, loadTheme } from "./trailcraft/state/theme";

applyTheme(loadTheme());

function InternalPreviewNotice() {
  return (
    <p className="manus-internal-preview" role="status">
      内部预览 · 地图服务与位置数据合规核验中，不对外发布
    </p>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TrailCraftApp />
    <InternalPreviewNotice />
  </StrictMode>,
);
