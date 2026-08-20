/* 山脊工作台：保留原始地图优先工作流；界面视觉由 TrailCraft 设计令牌统一控制。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ErrorBoundary from "./components/ErrorBoundary";
import TrailCraftApp from "./trailcraft/App";
import "./trailcraft/index.css";
import "./trailcraft/manus-preview.css";
import { applyTheme, loadTheme } from "./trailcraft/state/theme";

applyTheme(loadTheme());

function InternalPreviewNotice() {
  return (
    <p className="manus-internal-preview" role="status">
      公众候选版本 · 地图加载取决于当前网络与服务端点
    </p>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <TrailCraftApp />
    </ErrorBoundary>
    <InternalPreviewNotice />
  </StrictMode>,
);
