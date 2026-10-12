import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <div className="hud-panel w-full max-w-sm p-6">
        <p className="brand-label">404_NOT_FOUND</p>
        <h1 className="mt-2 text-2xl font-semibold leading-tight">There's no page here.</h1>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{location.pathname}</p>
        <Button asChild variant="outline" className="mt-6">
          <Link to="/">Back to the live landing page</Link>
        </Button>
      </div>
    </main>
  );
};

export default NotFound;
