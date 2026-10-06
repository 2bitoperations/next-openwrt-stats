# Next.js OpenWrt Stats

A web dashboard for monitoring and managing all your OpenWrt APs from a single place.

## Features

### 🌐 Network Monitoring
- **Real-time Traffic Monitoring**: Live upload/download speeds with interactive charts
- **Network Interface Information**: Detailed status of all network interfaces
- **Router Information**: System stats including uptime, load average, and memory usage
- **DHCP Client Management**: View all connected devices with IP/MAC addresses and lease times

### 📡 WiFi Management
- **Access Point Control**: View and manage all WiFi APs across your network
- **WiFi Client Monitoring**: Real-time traffic stats for connected wireless clients
- **Signal Strength Monitoring**: View signal quality, noise levels, and connection details
- **Client Presence Tracking**: Monitor WiFi client connection/disconnection history with detailed event logs including:
  - **Event Detection**: Automatically detects when clients connect, disconnect, or move between APs/routers
  - **Historical Timeline**: View detailed connection history for each client
  - **Change Tracking**: Monitors when clients switch between WiFi networks, routers, or frequency bands

### 🔄 System Management
- **Update Manager**: Check for and install OpenWrt firmware updates across all routers
  - **Version Checking**: Automatically detect available firmware updates
  - **Custom Packages**: Edit and customize packages to include in the firmware build
  - **Configuration Backup**: Download backups before updating

### 🔒 VPN & Security
- **WireGuard Management**: WireGuard VPN interface and peer management
- **Policy Based Routing (PBR)**: Manage OpenWrt's PBR package through the web interface


## Screenshots

### Main Dashboard
![Main Page](preview/Main%20Page.png)

### Router Management
![Routers Manager](preview/Routers%20Manager.png)

### Clients
![Clients](preview/Clients.png)

### WiFi Management
![Wifi Details](preview/Wifi%20Details.png)

### Client Presence Tracking

| | |
|---|---|
| ![Presence 1](preview/Presence%201.png) | ![Presence 2](preview/Presence%202.png) |

### Policy Based Routing
![PBR 2](preview/PBR%202.png)

### WireGuard VPN
![Wireguard](preview/Wireguard.png)

### System Logs
![Logs](preview/Logs.png)

### Update Manager
![Update Manager](preview/Update%20Manager.png)

## Quick Start (Docker Compose)

1. **Create Docker Compose configuration**
   ```yaml
   # docker-compose.yaml
   services:
     openwrtstats:
       image: lov432/openwrt-stats:latest
       container_name: openwrtstats
       volumes:
         - ./db/:/app/drizzle/db/
       environment:
         - MAX_TRAFFIC=100 # Maximum traffic threshold for charts (in Mbps)
         - PBR_ENABLED=false # Enable Policy Based Routing UI (requires OpenWrt pbr package)
         - PRESENCE_ENABLED=false # Enable WiFi client presence tracking and history
       ports:
         - 3000:3000
       restart: unless-stopped
   ```

3. **Start the application**
   ```bash
   docker-compose up -d
   ```

4. **Access the dashboard**
   Open your browser and navigate to `http://localhost:3000`

5. **Register your network devices**
    - On first launch, you'll be redirected to the registration page
    - Register your primary OpenWrt router first (main router that manages the network)
    - Add additional access points as needed - these are APs running OpenWrt, not separate networks

## Configuration

### OpenWrt RPC Configuration

**Required Setup Step**: On your primary OpenWrt router and all access points, create the following ACL file:

```bash
# Create the ACL file
vi /usr/share/rpcd/acl.d/openwrt-stats.json
```

Add this content to the file:

```json
{
        "openwrt-stats": {
                "description": "Grant UCI access to OpenwrtStats",
                "write": {
                        "ubus": {
                                "uci": [
                                        "set", "commit", "revert"
                                ],
                                "hostapd.*": ["get_clients"]
                        }
                }
        }
}
```

After creating the file, restart the rpcd service:

```bash
/etc/init.d/rpcd restart
```
### Per-client traffic (wired and wireless)

Client traffic history needs per-MAC byte counters from the routers/APs. The
collector picks **one** counter basis per client, in this order:

1. **`macacct`** (preferred): an OpenWrt package that counts every frame each
   client sends/receives on a bridge (`br-lan`) with an nftables bridge table -
   wired or Wi-Fi, internet or LAN-local, no conntrack. Each node only counts on
   its client-facing ports (batman-adv `bat*` ports and any configured uplink
   are "transit"), so every client is counted once, at the node it is attached
   to. Install the package (it ships its own rpcd ACL), and on the node that
   connects a mesh to the router mark the wired uplink as transit:
   ```bash
   uci add_list macacct.main.transit='eth0.1'   # that node's uplink port
   uci commit macacct
   ```
   Source and design notes: `feed-heltec/macacct` in the heltec-halow-adapters
   port tree. From macacct 2 each client's traffic is also split into
   **Internet** (the other end is the site router's MAC, detected from the
   node's default route) and **LAN** (everything else); the client history
   dialog shows Total / LAN / Internet charts. Planned next:
   [per-peer LAN breakdown](docs/per-peer-lan-breakdown.md).
2. **Wi-Fi station counters** (hostapd/iwinfo): used when no node reports the
   client via `macacct`. Wi-Fi only; counters reset when a client reassociates.
3. **`nlbwmon`** (fallback): counts only routed traffic between a local and a
   non-local network - nothing that is merely bridged and no LAN-local traffic,
   so it is only meaningful on the router itself. Needs an extra ACL entry:
   ```json
   "file": { "/usr/sbin/nlbw -c json -g mac show": ["exec"] }
   ```
   (alongside `"ubus": { "file": ["exec"] }` in the `write` section above), and
   `net.core.rmem_max=1048576` in `/etc/sysctl.conf` so its netlink buffer isn't
   silently clamped.

Each router is probed once for which of `macacct`/`nlbw` it has; a router with
neither is re-probed every 5 minutes. Don't run `nlbwmon` and `macacct` for the
same clients and expect them to add up - the collector never sums the two for
one MAC (it uses `macacct`).
