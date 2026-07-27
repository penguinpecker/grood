import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";
const ROBINHOOD_RPC = process.env.ROBINHOOD_RPC || "https://rpc.mainnet.chain.robinhood.com";
const ROBINHOOD_TESTNET_RPC = process.env.ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com";

const config: HardhatUserConfig = {
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  solidity: {
    version: "0.8.24",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    robinhood: {
      url: ROBINHOOD_RPC,
      accounts: [PRIVATE_KEY],
      chainId: 4663,
    },
    "robinhood-testnet": {
      url: ROBINHOOD_TESTNET_RPC,
      accounts: [PRIVATE_KEY],
      chainId: 46630,
    },
    hardhat: {
      chainId: 31337,
      // Just after drand evmnet genesis (2024-09-28T10:57:55Z) so tests can
      // warp forward onto real historical beacon rounds.
      initialDate: "2024-09-28T12:00:00Z",
    },
  },
  etherscan: {
    // Blockscout instances accept any non-empty API key string
    apiKey: {
      robinhood: "blockscout",
    },
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
};

export default config;
