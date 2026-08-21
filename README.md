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
```

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

Build the frontend:

```bash
npm run build
```

This builds the Next.js frontend and copies the generated files from `./frontend/out` to `./src/frontend`.

Once the build is complete, start Cyrus Panel:

```bash
npm run start
```

For development:

```bash
npm run dev
```

## Links

* **Website:** https://cyrus.admibot.xyz
* **Documentation:** https://cyrus.admibot.xyz/docs
* **Bug Reports:** https://cyrus.admibot.xyz/bugs
* **Support Server:** https://discord.gg/3yuMkSnrFd

## License

See the [LICENSE](https://github.com/HasenDev/cyrus-panel/blob/main/LICENSE) file.
