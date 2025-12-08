import { DeployFunction, DeployResult, DeploymentsExtension } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getExistingContractAddresses } from "../config/overwrite";
import path from "path";
import { findFile, readJsonFile, searchDirectory } from "./file";

// Nonce error retry configuration
const NONCE_RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 3000,
  maxDelayMs: 30000,
};

// Check if error is a nonce-related error
function isNonceError(error: any): boolean {
  const errorMessage = error?.message || error?.toString() || "";
  const noncePatterns = [
    /nonce.*too low/i,
    /nonce.*already.*used/i,
    /NONCE_EXPIRED/i,
    /replacement transaction underpriced/i,
    /transaction.*underpriced/i,
    /already known/i,
    /nonce.*mismatch/i,
  ];
  return noncePatterns.some((pattern) => pattern.test(errorMessage));
}

// Wait with exponential backoff
async function waitWithBackoff(attempt: number): Promise<void> {
  const delay = Math.min(NONCE_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt), NONCE_RETRY_CONFIG.maxDelayMs);
  console.log(`  Waiting ${delay}ms before retry (attempt ${attempt + 1}/${NONCE_RETRY_CONFIG.maxRetries})...`);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function deployContract(name, args, contractOptions = {}) {
  const contractFactory = await ethers.getContractFactory(name, contractOptions);

  // Deploy with nonce error retry logic
  let lastError: any;
  for (let attempt = 0; attempt < NONCE_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const contract = await contractFactory.deploy(...args);
      await contract.deployed();
      return contract;
    } catch (e) {
      lastError = e;

      if (isNonceError(e)) {
        console.log(`  Nonce error in deployContract for ${name}: ${e.message || e}`);

        if (attempt < NONCE_RETRY_CONFIG.maxRetries - 1) {
          await waitWithBackoff(attempt);
          console.log(`  Retrying deployContract for ${name}...`);
          continue;
        }
      }

      // Re-throw non-nonce errors or after max retries
      throw e;
    }
  }

  throw new Error(`deployContract failed after ${NONCE_RETRY_CONFIG.maxRetries} retries: ${lastError}`);
}

export async function contractAt(name, address, provider?) {
  return ethers.getContractAt(name, address, provider);
}

export function createDeployFunction({
  contractName,
  dependencyNames = [],
  getDependencies,
  getDeployArgs = null,
  libraryNames = [],
  afterDeploy = null,
  id,
}: {
  contractName: string;
  dependencyNames?: string[];
  getDeployArgs?: (args: { dependencyContracts: any }) => Promise<any[]>;
  libraryNames?: string[];
  afterDeploy?: (args: {
    deployedContract: DeployResult;
    deployer: string;
    getNamedAccounts: () => Promise<Record<string, string>>;
    deployments: DeploymentsExtension;
    gmx: any;
    network: any;
  }) => Promise<void>;
  id?: string;
}): DeployFunction & Required<Pick<DeployFunction, "dependencies">> {
  const func = async ({ getNamedAccounts, deployments, gmx, network }: HardhatRuntimeEnvironment) => {
    const { deploy, get } = deployments;
    const { deployer } = await getNamedAccounts();

    const dependencyContracts = getExistingContractAddresses(network);

    if (dependencyNames) {
      for (let i = 0; i < dependencyNames.length; i++) {
        const dependencyName = dependencyNames[i];
        if (dependencyContracts[dependencyName] === undefined) {
          dependencyContracts[dependencyName] = await get(dependencyName);
        }
      }
    }

    let deployArgs = [];
    if (getDeployArgs) {
      deployArgs = await getDeployArgs({ dependencyContracts, network, gmx, get, getNamedAccounts });
    }

    const libraries = {};

    if (libraryNames) {
      for (let i = 0; i < libraryNames.length; i++) {
        const libraryName = libraryNames[i];
        libraries[libraryName] = (await get(libraryName)).address;
      }
    }

    let deployedContract: DeployResult;

    let waitConfirmations;
    if (network.name === "avalanche" || network.name === "botanix") {
      waitConfirmations = 2;
    }

    // Add wait confirmations for BSC networks to avoid nonce issues
    if (network.name === "bsc" || network.name === "bscTestnet") {
      waitConfirmations = 2;
    }

    // Deploy with nonce error retry logic
    let lastError: any;
    for (let attempt = 0; attempt < NONCE_RETRY_CONFIG.maxRetries; attempt++) {
      try {
        deployedContract = await deploy(contractName, {
          from: deployer,
          log: true,
          args: deployArgs,
          libraries,
          waitConfirmations,
        });
        // Success - break out of retry loop
        break;
      } catch (e) {
        lastError = e;

        if (isNonceError(e)) {
          console.log(`  Nonce error detected for ${contractName}: ${e.message || e}`);

          if (attempt < NONCE_RETRY_CONFIG.maxRetries - 1) {
            await waitWithBackoff(attempt);
            console.log(`  Retrying deployment of ${contractName}...`);
            continue;
          }
        }

        // For non-nonce errors or after max retries, try hardhat deploy for better error message
        try {
          await deployContract(contractName, deployArgs, {
            libraries,
          });
        } catch (hardhatError) {
          // If hardhat deploy also fails, it might give us a better error message
          console.error(`  Hardhat deploy error: ${hardhatError}`);
        }

        // throw an error even if the hardhat deploy works
        // because the actual deploy did not succeed
        throw new Error(`Deploy failed with error ${e}`);
      }
    }

    // If we got here without deployedContract, throw the last error
    if (!deployedContract) {
      throw new Error(`Deploy failed after ${NONCE_RETRY_CONFIG.maxRetries} retries with error ${lastError}`);
    }

    if (afterDeploy) {
      await afterDeploy({ deployedContract, deployer, getNamedAccounts, deployments, gmx, network });
    }

    if (id) {
      // hardhat-deploy would not redeploy a contract if it already exists with the same id
      // with `id` it's possible to control whether a contract should be redeployed
      return true;
    }
  };

  let dependencies = false;

  if (getDependencies !== undefined) {
    dependencies = getDependencies();
  }

  if (dependencies === false) {
    dependencies = [];
    if (dependencyNames) {
      dependencies = dependencies.concat(dependencyNames);
    }
    if (libraryNames) {
      dependencies = dependencies.concat(libraryNames);
    }
  }

  if (id) {
    func.id = id;
  }
  func.tags = [contractName];
  func.dependencies = dependencies;
  func.contractName = contractName;
  return func;
}

function getArtifact(contractName: string) {
  const findContract = findFile(contractName + ".json");
  const artifactPath = path.join(__dirname, "../artifacts/contracts/");
  const searchResult = searchDirectory(artifactPath, findContract);
  return readJsonFile(searchResult);
}

function getDeployment(contractName: string, network: string) {
  const findContract = findFile(contractName + ".json");
  const deploymentsPath = path.join(__dirname, `../deployments/${network}/`);
  const searchResult = searchDirectory(deploymentsPath, findContract);
  return readJsonFile(searchResult);
}

export function skipHandlerFunction(contractName: string): (env: HardhatRuntimeEnvironment) => Promise<boolean> {
  return async function skip(env: HardhatRuntimeEnvironment) {
    const tags = env.deployTags?.split(",") ?? [];
    if (tags.includes(contractName) || hre.network.name === "hardhat") {
      return false;
    }
    const shouldSkip = process.env.SKIP_AUTO_HANDLER_REDEPLOYMENT == "true" ? true : false;

    // Check that handler ABI didn't changed since last deploy
    const artifact = getArtifact(contractName);
    const deployment = getDeployment(contractName, hre.network.name);
    if (!deployment) {
      return false;
    }
    if (shouldSkip && JSON.stringify(deployment.abi) !== JSON.stringify(artifact.abi)) {
      throw new Error(`ABI has been changed for ${contractName}, but contract is not picked for deploy!`);
    }
    return shouldSkip;
  };
}
