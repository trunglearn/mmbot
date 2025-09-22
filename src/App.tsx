
import React, { useState } from "react";
import BscSwap from "./BscSwap";
import SolSwap from "./SolSwap";
import SuiSwapCetus from "./SuiSwapCetus";
import MultiSend from "./MultiSend";


type TabKey = "sol" | "bsc" | "sui" | "multi";

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("sol");
  const renderSwap = () => {
    if (activeTab === "sol") {
      return <SolSwap />;
    } else if (activeTab === "bsc") {
      return <BscSwap />;
    } else {
      if (activeTab === "sui") return <SuiSwapCetus />;
      return <MultiSend />;
    }
  };

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
          <button
            onClick={() => setActiveTab("sui")}
            className={`flex-1 py-3 text-center font-medium ${activeTab === "sui" ? "bg-white text-amber-700" : "bg-green-800/30 text-white hover:bg-green-800/50"}`}
          >
            SUI · Cetus
          </button>
          <button
            onClick={() => setActiveTab("multi")}
            className={`flex-1 py-3 text-center font-medium ${activeTab === "multi" ? "bg-white text-green-900" : "bg-green-800/30 text-white hover:bg-green-800/50"}`}
          >
            Multi Send
          </button>
        </div>

        {/* Tab content */}
        {renderSwap()}
      </div>
    </div>
  );
}

export default App;
