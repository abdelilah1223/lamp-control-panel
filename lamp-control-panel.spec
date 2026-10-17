
Name:           lamp-control-panel
Version:        1.1.0
Release:        1%{?dist}
Summary:        Advanced LAMP and PHP Control Dashboard
License:        MIT
URL:            https://github.com/abdelilah1223/lamp-control-panel

Source0:        https://github.com/abdelilah1223/lamp-control-panel/archive/refs/tags/v%{version}.tar.gz
Source1:        lamp-control-panel.desktop

BuildRequires:  nodejs
BuildRequires:  npm
BuildRequires:  desktop-file-utils

Requires:       gtk3
Requires:       nss
Requires:       libX11
Requires:       libxkbcommon
Requires:       mesa-libgbm
Requires:       alsa-lib

BuildArch:      x86_64

%description
An Electron desktop dashboard for managing PHP, MariaDB
and phpMyAdmin services.

%prep
%autosetup -n lamp-control-panel-%{version}

%build
npm install --omit=dev
npm run build --if-present

%install
mkdir -p %{buildroot}/opt/lamp-control-panel
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/512x512/apps

# Package the application and its production dependencies.
cp -a . %{buildroot}/opt/lamp-control-panel/

# Launcher
cat > %{buildroot}%{_bindir}/lamp-control-panel <<'EOF'
#!/bin/sh
cd /opt/lamp-control-panel
exec ./node_modules/.bin/electron ./main.js "$@"
EOF
chmod 755 %{buildroot}%{_bindir}/lamp-control-panel

# Desktop entry
install -m 644 %{SOURCE1} \
  %{buildroot}%{_datadir}/applications/lamp-control-panel.desktop

# Application icon
install -m 644 build/icon.png \
  %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/lamp-control-panel.png

%files
/opt/lamp-control-panel
%{_bindir}/lamp-control-panel
%{_datadir}/applications/lamp-control-panel.desktop
%{_datadir}/icons/hicolor/512x512/apps/lamp-control-panel.png

%changelog
* Sat Oct 17 2026 Abdelilah El Baroudi <albaroudiabdelilah92@gmail.com> - 1.1.0-1
- Initial RPM packaging
