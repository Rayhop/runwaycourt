import { calibration } from "@filoz/synapse-core/chains"
const abi = calibration.contracts.usdfc.abi as any[]
console.log("usdfc fns:", abi.filter((x) => x.type === "function").map((f) => f.name).join(", "))
console.log("pay :", calibration.contracts.filecoinPay.address)
console.log("fwss:", calibration.contracts.fwss.address)
