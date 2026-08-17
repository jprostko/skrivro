# skrivro.spec: RPM package for Skrivro, assembled from the staging tree.
#
# Invoked by build.sh, which supplies these macros:
#   pkgver     version read from tauri.conf.json
#   repo_root  app repo root (binary, resources, LICENSE, ...)
#   pkg_dir    the packaging/ directory holding stage.sh + assets
#   app_bin    optional binary override, passed through to stage.sh
#
# The BINARY IS NOT BUILT HERE. Build it first the same way the PKGBUILD
# does (--features tauri/custom-protocol, see packaging/arch/PKGBUILD).
#
# Runtime dependencies are NOT declared manually: rpmbuild's elf dep
# generator turns the binary's DT_NEEDED into soname Requires that
# resolve on any RPM distro. Only hicolor-icon-theme is explicit (we
# install into its directory tree). No %post scriptlets: Fedora and
# openSUSE rebuild the icon cache, MIME database, and desktop database
# via file triggers owned by the respective tool packages.

# Prebuilt-binary specifics: no debuginfo subpackage, and no
# /usr/lib/.build-id symlink farm (it would trip the unpackaged-files
# check for a binary we did not compile in %build).
%global debug_package %{nil}
%global _build_id_links none

Name:           skrivro
Version:        %{pkgver}
Release:        1%{?dist}
Summary:        Keyboard-first AsciiDoc and Markdown editor with live preview
License:        0BSD
URL:            https://github.com/jprostko/skrivro
Packager:       Joseph R. Prostko <joe.prostko@gmail.com>
ExclusiveArch:  x86_64

Requires:       hicolor-icon-theme

%description
A keyboard-first editor for AsciiDoc and Markdown with a live side-by-side
preview. Documents render as you type, with three display modes: editor
only, split, or preview only. Vim emulation is available as a first-class
option, and the interface stays minimal, a single status bar and no
toolbars. It runs offline and makes no network requests of its own.

%install
STAGE=%{buildroot} REPO_ROOT=%{repo_root} \
    %{?app_bin:BIN=%{app_bin}} \
    %{pkg_dir}/stage.sh
# Strip the staged copy (never the input). No compile step here means the
# distro's automatic strip-during-build may not cover it.
strip %{buildroot}%{_bindir}/%{name}

%files
%{_bindir}/%{name}
%{_datadir}/applications/com.skrivro.editor.desktop
%{_datadir}/mime/packages/com.skrivro.editor.xml
%{_datadir}/metainfo/com.skrivro.editor.metainfo.xml
%{_datadir}/icons/hicolor/*/apps/com.skrivro.editor.*
%doc %{_datadir}/doc/%{name}/
%license %{_datadir}/licenses/%{name}/
