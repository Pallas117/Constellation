import { useState, useRef } from 'react';
import { useSpaceWeather } from '@/hooks/useSpaceWeather';
import { GaussGlobe } from '@/components/GaussGlobe';
import { Shield, Activity, Globe, Zap, ArrowRight, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.15, delayChildren: 0.4 }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { 
    opacity: 1, 
    y: 0, 
    transition: { type: 'spring', stiffness: 60, damping: 15 } 
  }
};

export default function PublicDashboard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { data, visualParams } = useSpaceWeather();

  const isE2E =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('e2e');

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black font-sans text-white">
      {/* 3D Scene Background */}
      <div className="absolute inset-0 z-0">
        <GaussGlobe
          layers={{
            earth: true,
            belts: true,
            magnetosphere: true,
            fieldLines: true,
            mhdWaves: false,
            mmsReconnection: false,
          }}
          visualParams={visualParams}
          encodingMode="color"
          canvasRef={canvasRef}
          isE2E={isE2E}
        />
      </div>

      {/* Premium Glassmorphic Overlay */}
      <div className="absolute inset-0 z-10 pointer-events-none flex flex-col justify-between p-8 md:p-12">
        
        {/* Header Section */}
        <motion.header 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="flex justify-between items-start"
        >
          <div className="pointer-events-auto">
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight bg-gradient-to-br from-white via-white to-white/40 bg-clip-text text-transparent drop-shadow-lg">
              Gauss Aurora
            </h1>
            <p className="text-white/60 mt-2 text-sm md:text-base font-light tracking-wide max-w-md">
              Real-time monitoring of Earth's magnetosphere. Protecting critical orbital and terrestrial infrastructure from space weather anomalies.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 pointer-events-auto">
            <Link 
              to="/operator" 
              className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 backdrop-blur-md transition-all text-sm font-medium"
            >
              <Lock className="w-4 h-4" />
              Operator Portal
            </Link>
            <Link
              to="/member"
              className="flex items-center gap-2 px-5 py-2.5 rounded-full border border-white/20 bg-white/5 text-sm font-medium text-white/90 hover:bg-white/10 transition-all"
            >
              <Globe className="w-4 h-4" />
              Member Hub
            </Link>
          </div>
        </motion.header>

        {/* Real-time Telemetry Widgets */}
        <motion.div 
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-5xl mx-auto pointer-events-auto"
        >
          
          {/* Solar Wind Widget */}
          <motion.div variants={itemVariants} className="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-xl shadow-2xl relative overflow-hidden group hover:bg-white/10 transition-colors">
            <div className="absolute top-0 right-0 p-4 opacity-20 group-hover:opacity-40 transition-opacity">
              <Zap className="w-12 h-12" />
            </div>
            <div className="flex items-center gap-2 text-white/60 mb-4 text-sm font-medium tracking-wide uppercase">
              <Activity className="w-4 h-4 text-emerald-400" />
              Solar Wind Velocity
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-bold tracking-tighter">
                {Math.round(data.solarWind.speed)}
              </span>
              <span className="text-white/40 font-medium">km/s</span>
            </div>
            <div className="mt-4 h-1 w-full bg-white/10 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(100, Math.max(0, (data.solarWind.speed - 300) / 5))}%` }}
                transition={{ duration: 1.5, ease: "easeOut", delay: 1 }}
                className="h-full bg-gradient-to-r from-emerald-400 to-cyan-400" 
              />
            </div>
          </motion.div>

          {/* Planetary K-index Widget */}
          <motion.div variants={itemVariants} className="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-xl shadow-2xl relative overflow-hidden group hover:bg-white/10 transition-colors">
            <div className="absolute top-0 right-0 p-4 opacity-20 group-hover:opacity-40 transition-opacity">
              <Globe className="w-12 h-12" />
            </div>
            <div className="flex items-center gap-2 text-white/60 mb-4 text-sm font-medium tracking-wide uppercase">
              <Shield className="w-4 h-4 text-violet-400" />
              Geomagnetic Activity (Kp)
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-bold tracking-tighter">
                {data.kpIndex.toFixed(1)}
              </span>
              <span className="text-white/40 font-medium">/ 9.0</span>
            </div>
            <div className="mt-4 flex gap-1">
              {[...Array(9)].map((_, i) => (
                <motion.div 
                  key={i} 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1 + (i * 0.1) }}
                  className={`flex-1 h-1 rounded-full transition-colors ${i < Math.round(data.kpIndex) ? (i > 5 ? 'bg-red-500' : 'bg-violet-400') : 'bg-white/10'}`} 
                />
              ))}
            </div>
          </motion.div>

          {/* Interplanetary Magnetic Field Widget */}
          <motion.div variants={itemVariants} className="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-xl shadow-2xl relative overflow-hidden group hover:bg-white/10 transition-colors">
            <div className="absolute top-0 right-0 p-4 opacity-20 group-hover:opacity-40 transition-opacity">
              <ArrowRight className="w-12 h-12 rotate-[-45deg]" />
            </div>
            <div className="flex items-center gap-2 text-white/60 mb-4 text-sm font-medium tracking-wide uppercase">
              <Activity className="w-4 h-4 text-amber-400" />
              IMF Bz
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-bold tracking-tighter">
                {data.imfBz > 0 ? '+' : ''}{data.imfBz.toFixed(1)}
              </span>
              <span className="text-white/40 font-medium">nT</span>
            </div>
            <p className="mt-4 text-xs text-white/50 leading-relaxed">
              {data.imfBz < -5 
                ? "Southward IMF is enabling magnetic reconnection and potential storm activity." 
                : "IMF is stable. Magnetosphere is currently shielded form major solar wind coupling."}
            </p>
          </motion.div>

        </motion.div>

        {/* Footer */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.5, duration: 1 }}
          className="flex justify-between items-end"
        >
          <div className="text-white/40 text-xs tracking-widest uppercase font-mono">
            Powered by DeepMind & Next-Gen Space AI
          </div>
          <div className="flex items-center gap-3 pointer-events-auto hover:text-white transition-colors cursor-pointer">
             <div className="flex items-center gap-2 bg-white/5 border border-white/10 backdrop-blur-md px-3 py-1.5 rounded-full">
               <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
               <span className="text-xs font-medium text-white/80 tracking-widest">LIVE</span>
             </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
