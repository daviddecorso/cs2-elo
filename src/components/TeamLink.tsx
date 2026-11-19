import { Link } from "react-router-dom";
import { TeamLogo } from "./TeamLogo.tsx";
import { teamPath } from "../utils/teams.ts";

export const TeamLink = ({ team, logoSize }: { team: string; logoSize?: number }) => (
    <Link to={teamPath(team)} className="inline-flex items-center gap-2 font-medium text-fg hover:text-accent transition-colors">
        <TeamLogo team={team} size={logoSize} />
        {team}
    </Link>
);
