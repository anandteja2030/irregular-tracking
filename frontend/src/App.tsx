import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { AmbientField } from "./components/AmbientField";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ApiHealthProvider } from "./app/ApiHealthProvider";
import { SessionProvider } from "./app/SessionProvider";
import { OverviewPage } from "./pages/OverviewPage";
import { VideoStudioPage } from "./pages/VideoStudioPage";
import { TrackExplorerPage } from "./pages/TrackExplorerPage";
import { AnomalyCenterPage } from "./pages/AnomalyCenterPage";
import { SceneIntelligencePage } from "./pages/SceneIntelligencePage";
import { EvaluationPage } from "./pages/EvaluationPage";
import { SettingsPage } from "./pages/SettingsPage";
import { NotFoundPage } from "./pages/NotFoundPage";

function ShellLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    setPaletteOpen(false);
    const workspace = document.querySelector<HTMLElement>(".workspace");
    // jsdom has no scrollTo; the shell must render there too.
    if (typeof workspace?.scrollTo === "function") workspace.scrollTo({ top: 0 });
  }, [pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <SessionProvider>
    <div className="app">
      <AmbientField />
      <Sidebar />
      <div className="shell">
        <TopBar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="workspace" id="workspace">
          <div className="workspace__inner" key={pathname}>
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
    </SessionProvider>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<ShellLayout />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/video-studio" element={<VideoStudioPage />} />
        <Route path="/tracks" element={<TrackExplorerPage />} />
        <Route path="/anomalies" element={<AnomalyCenterPage />} />
        <Route path="/scene" element={<SceneIntelligencePage />} />
        <Route path="/evaluation" element={<EvaluationPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </BrowserRouter>
  );
}
