# Cyrus Panel

> A modern, open-source server management panel for managing servers, nodes, containers, resources, and infrastructure.

[![License](https://img.shields.io/github/license/HasenDev/cyrus-panel)](https://github.com/HasenDev/cyrus-panel/blob/main/LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/HasenDev/cyrus-panel?style=flat)](https://github.com/HasenDev/cyrus-panel/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/HasenDev/cyrus-panel)](https://github.com/HasenDev/cyrus-panel/issues)

## Setting up the environment

Cyrus Panel requires **Node.js v21 or newer**.

**Node.js v24.19.0 is the currently tested version**, but it is not required.

### Install with NVM

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24.19.0
nvm use 24.19.0
````

### Or install using your Linux distribution

**Debian / Ubuntu**

```bash
sudo apt update
sudo apt install -y nodejs npm
```

**Fedora / RHEL / Rocky / AlmaLinux**

```bash
sudo dnf install -y nodejs npm
```

**Arch Linux**

```bash
sudo pacman -S nodejs npm
```

> Make sure your installed Node.js version is **v21 or newer**.

## Installation

Clone the repository and install the dependencies:

```bash
git clone https://github.com/HasenDev/cyrus-panel.git
cd cyrus-panel
npm install
```

### Initialize the frontend

Cyrus Panel uses the **Cyrus Frontend** as a Git submodule. After cloning the repository, initialize and download the frontend submodule:

```bash
git submodule update --init --recursive
```

> **Important:** The frontend is required to build Cyrus Panel. Make sure you run the command above before running `npm run build`.

### Build Cyrus Panel

Build the frontend and prepare it for the API server:

```bash
npm run build
```

This builds the Next.js frontend from the `frontend` submodule and copies the generated static files from:

```text
./frontend/out
```

to:

```text
./src/frontend
```

### Updating the frontend

If you already have Cyrus Panel installed and want to update the frontend submodule to the version referenced by the panel repository, run:

```bash
git pull
git submodule update --init --recursive
```

Then rebuild Cyrus Panel:

```bash
npm run build
```

> **Note:** `git submodule update --init --recursive` checks out the exact frontend commit referenced by the Cyrus Panel repository. This ensures that the frontend version matches the panel version.

Once the build is complete, start Cyrus Panel:

```bash
npm run start
```

For development:

```bash
npm run dev
```

## Links

* **Website:** [https://cyrus.admibot.xyz](https://cyrus.admibot.xyz)
* **Documentation:** [https://cyrus.admibot.xyz/docs](https://cyrus.admibot.xyz/docs)
* **Bug Reports:** [https://cyrus.admibot.xyz/bugs](https://cyrus.admibot.xyz/bugs)
* **Support Server:** [https://discord.gg/3yuMkSnrFd](https://discord.gg/3yuMkSnrFd)

## License

See the [LICENSE](https://github.com/HasenDev/cyrus-panel/blob/main/LICENSE) file.
