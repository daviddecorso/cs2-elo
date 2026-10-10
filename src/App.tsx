import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Standings } from "./pages/Standings.tsx";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 1000 * 60 * 10,
            gcTime: 1000 * 60 * 30,
            retry: 1,
        },
    },
});

export const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
            <BrowserRouter basename="/cs2">
                <Routes>
                    <Route path="/" element={<Standings />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </BrowserRouter>
        </QueryClientProvider>
    );
};

export default App;
