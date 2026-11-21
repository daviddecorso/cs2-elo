import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./components/AppShell.tsx";
import { Standings } from "./pages/Standings.tsx";
import { Rankings } from "./pages/Rankings.tsx";
import { TeamPage } from "./pages/TeamPage.tsx";
import { Model } from "./pages/Model.tsx";
import { Methodology } from "./pages/Methodology.tsx";
import { EventList, EventOdds } from "./pages/EventOdds.tsx";
import { Major } from "./pages/Major.tsx";
import { VrsSim } from "./pages/VrsSim.tsx";
import { Players } from "./pages/Players.tsx";
import { PlayerPage } from "./pages/PlayerPage.tsx";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 1000 * 60 * 10,
            gcTime: 1000 * 60 * 30,
            retry: 1,
        },
    },
});

/** Keeps the query string, so old `/elo?q=…` links still filter. */
const RedirectKeepingQuery = ({ to }: { to: string }) => {
    const { search } = useLocation();
    return <Navigate to={`${to}${search}`} replace />;
};

/** `/major-invites?major=<slug>&…` → `/major/<slug>?…`. */
const MajorInvitesRedirect = () => {
    const { search } = useLocation();
    const params = new URLSearchParams(search);
    const major = params.get("major");
    params.delete("major");
    const query = params.toString();
    return <Navigate to={`/major${major ? `/${major}` : ""}${query ? `?${query}` : ""}`} replace />;
};

export const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
            <BrowserRouter basename="/cs2">
                <Routes>
                    <Route element={<AppShell />}>
                        <Route path="/" element={<Standings />} />
                        <Route path="/vrs" element={<Standings />} />
                        <Route path="/standings" element={<RedirectKeepingQuery to="/vrs" />} />
                        <Route path="/rankings" element={<Rankings />} />
                        <Route path="/elo" element={<RedirectKeepingQuery to="/rankings" />} />
                        <Route path="/teams/:team" element={<TeamPage />} />
                        <Route path="/events" element={<EventList />} />
                        <Route path="/events/:slug" element={<EventOdds />} />
                        <Route path="/major" element={<Major />} />
                        <Route path="/major/:slug" element={<Major />} />
                        <Route path="/major-invites" element={<MajorInvitesRedirect />} />
                        <Route path="/vrs-sim" element={<VrsSim />} />
                        <Route path="/players" element={<Players />} />
                        <Route path="/players/:player" element={<PlayerPage />} />
                        <Route path="/war" element={<RedirectKeepingQuery to="/players" />} />
                        <Route path="/model" element={<Model />} />
                        <Route path="/methodology" element={<Methodology />} />
                    </Route>
                    <Route path="*" element={<Navigate to="/rankings" replace />} />
                </Routes>
            </BrowserRouter>
        </QueryClientProvider>
    );
};

export default App;
