
import React, { useState } from "react";
import BscSwap from "./BscSwap";
import SolSwap from "./SolSwap";

type TabKey = "sol" | "bsc";

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("sol");

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-600 to-green-700 flex items-start justify-center p-4">
      <div className="w-full max-w-4xl">
        {/* Tabs header */}
        <div className="flex mb-4 rounded-xl overflow-hidden">
          <button
            onClick={() => setActiveTab("sol")}
            className={`flex-1 py-3 text-center font-medium ${activeTab === "sol" ? "bg-white text-green-700" : "bg-green-800/30 text-white hover:bg-green-800/50"}`}
          >
            SOL · Raydium
          </button>
          <button
            onClick={() => setActiveTab("bsc")}
            className={`flex-1 py-3 text-center font-medium ${activeTab === "bsc" ? "bg-white text-amber-700" : "bg-green-800/30 text-white hover:bg-green-800/50"}`}
          >
            BNB · Pancake V2
          </button>
        </div>

        {/* Tab content */}
        {activeTab === "sol" ? <SolSwap /> : <BscSwap />}
      </div>
    </div>
  );
}

export default App;
