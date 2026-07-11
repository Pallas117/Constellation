import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ui/ThemeProvider";
import { GaussThemeProvider } from "@/components/ThemeContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import PublicDashboard from "./pages/PublicDashboard";
import OperatorDashboard from "./pages/OperatorDashboard";
import Login from "./pages/Login";
import MemberHub from "./pages/MemberHub";
import ProtectionDashboard from "./pages/ProtectionDashboard";
import { ProtectedRoute } from "./components/ProtectedRoute";
import NotFound from "./pages/NotFound";
import HeliophysicsDashboard from "./pages/HeliophysicsDashboard";
import { ErrorBoundary } from "./components/ErrorBoundary";

const queryClient = new QueryClient();

const App = () => (
  <ErrorBoundary>
    <ThemeProvider defaultTheme="dark" storageKey="gauss-aurora-theme">
      <GaussThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<PublicDashboard />} />
                <Route path="/login" element={<Login />} />
                <Route 
                  path="/operator" 
                  element={
                    <ProtectedRoute>
                      <OperatorDashboard />
                    </ProtectedRoute>
                  } 
                />
                <Route path="/member" element={<MemberHub />} />
                <Route path="/heliophysics" element={<HeliophysicsDashboard />} />
                <Route 
                  path="/protection" 
                  element={
                    <ProtectedRoute>
                      <ProtectionDashboard />
                    </ProtectedRoute>
                  } 
                />
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
          </TooltipProvider>
        </QueryClientProvider>
      </GaussThemeProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
