$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;

public static class PreparedOutputObserver {
    static readonly object outputLock = new object();
    static void Send(object message) {
        lock (outputLock) {
            Console.Out.WriteLine(JsonSerializer.Serialize(message));
            Console.Out.Flush();
        }
    }
    static void Event(int id, string kind, string name) {
        Send(new { type = "event", id, eventType = kind, filename = name });
    }
    static void Observe(FileSystemWatcher watcher, int id, bool parent) {
        watcher.Changed += (s, e) => Event(id, parent ? "rename" : "change", parent ? null : e.Name);
        watcher.Created += (s, e) => Event(id, "rename", parent ? null : e.Name);
        watcher.Deleted += (s, e) => Event(id, "rename", parent ? null : e.Name);
        watcher.Renamed += (s, e) => {
            Event(id, "rename", parent ? null : e.OldName);
            Event(id, "rename", parent ? null : e.Name);
        };
        watcher.Error += (s, e) =>
            Send(new { type = "error", id, message = e.GetException().Message });
        watcher.EnableRaisingEvents = true;
    }
    public static void Run() {
        Console.OutputEncoding = new UTF8Encoding(false);
        var groups = new Dictionary<int, List<FileSystemWatcher>>();
        try {
            Send(new { type = "started" });
            string line;
            while ((line = Console.In.ReadLine()) != null) {
                using (var document = JsonDocument.Parse(line)) {
                    var message = document.RootElement;
                    var type = message.GetProperty("type").GetString();
                    var id = message.GetProperty("id").GetInt32();
                    if (type == "barrier") {
                        Send(new { type = "ready", id });
                    } else if (type == "close") {
                        if (groups.TryGetValue(id, out var group)) {
                            foreach (var watcher in group) watcher.Dispose();
                            groups.Remove(id);
                        }
                    } else if (type == "watch") {
                        var path = message.GetProperty("path").GetString();
                        var group = new List<FileSystemWatcher>();
                        groups.Add(id, group);
                        // LastAccess is not part of content integrity. Node's Windows
                        // watcher includes it, so reading a snapshot can overflow its queue.
                        var watcher = new FileSystemWatcher(path) {
                            IncludeSubdirectories = message.GetProperty("recursive").GetBoolean(),
                            InternalBufferSize = 8192,
                            NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName |
                                NotifyFilters.Attributes | NotifyFilters.Size | NotifyFilters.LastWrite |
                                NotifyFilters.CreationTime | NotifyFilters.Security
                        };
                        group.Add(watcher);
                        var parent = Path.GetDirectoryName(path);
                        if (!String.IsNullOrEmpty(parent)) {
                            var structure = new FileSystemWatcher(parent, Path.GetFileName(path)) {
                                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName |
                                    NotifyFilters.Attributes | NotifyFilters.Security
                            };
                            group.Add(structure);
                            Observe(structure, id, true);
                        }
                        Observe(watcher, id, false);
                    } else {
                        throw new InvalidDataException("Unknown observer command");
                    }
                }
            }
        } catch (Exception error) {
            Send(new { type = "error", message = error.Message });
        } finally {
            foreach (var group in groups.Values)
                foreach (var watcher in group) watcher.Dispose();
        }
    }
}
'@
[PreparedOutputObserver]::Run()
