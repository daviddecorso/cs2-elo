import { Link, Outlet, useLocation } from "react-router-dom";
import { SettingsMenu } from "./SettingsMenu.tsx";

const NAV_ITEMS = [{ path: "/", label: "Standings" }];

const navLinkClass = (active: boolean) =>
    `h-full inline-flex items-center px-3 text-xs font-mono font-medium border-b-2 whitespace-nowrap transition-colors ${
        active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
    }`;

export const AppShell = () => {
    const { pathname } = useLocation();

    return (
        <div className="min-h-screen bg-bg text-fg flex flex-col font-sans">
            <header className="sticky top-0 z-50 bg-surface border-b border-line">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center justify-between h-12">
                        <div className="flex items-center gap-2 sm:gap-3">
                            <Link
                                to="/"
                                className="font-mono font-bold text-sm tracking-tight text-fg hover:text-accent transition-colors"
                            >
                                Davelo
                            </Link>
                            <span className="rounded-sm border border-line px-1.5 py-0.5 bg-fg text-bg text-[10px] font-mono font-medium uppercase">
                                CS2
                            </span>
                        </div>

                        <nav className="hidden xl:flex h-12 items-center gap-1">
                            {NAV_ITEMS.map(({ path, label }) => (
                                <Link key={path} to={path} className={navLinkClass(pathname === path)}>
                                    {label}
                                </Link>
                            ))}
                        </nav>

                        <SettingsMenu />
                    </div>
                </div>

                <nav className="xl:hidden h-10 border-t border-line flex px-4 sm:px-6 lg:px-8 overflow-x-auto">
                    {NAV_ITEMS.map(({ path, label }) => (
                        <Link key={path} to={path} className={navLinkClass(pathname === path)}>
                            {label}
                        </Link>
                    ))}
                </nav>
            </header>

            <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex-1">
                <Outlet />
            </main>

            <footer className="border-t border-line py-4 px-4 text-center text-xs font-mono text-muted space-y-1">
                <div>Davelo / Event data for Regional Standings provided by HLTV.org</div>
                <div>CS2 Regional Standings model &copy; Valve Corporation</div>
            </footer>
        </div>
    );
};
